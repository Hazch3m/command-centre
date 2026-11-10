/**
 * The phone app's backend. The dashboard's own database runs here in the
 * browser (sql.js), loaded from the PC's latest encrypted snapshot. Reading is
 * all local, so the app works offline. Changes to your own things (tasks,
 * habits, plan days, a few view settings) are applied here at once and queued
 * for the PC, which replays them on its copy and sends back a fresh snapshot.
 * Nothing on the phone talks to Strava, Google or Garmin: the PC does that.
 *
 * Signed in with an account (the iPhone app), there needn't be a PC at all:
 * the sync service keeps the data, fetches from Garmin and applies the phone's
 * changes itself; this phone makes the account's first (empty) copy.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Backend, ExecResult, SqlParam, Statement } from "./backend.types";
import { accountHeader, buildAccountDb } from "./account";
import { GARMIN_SIGN_IN, native } from "./native";
import {
  b64url,
  cloudMayWrite,
  gunzip,
  gzip,
  linkKeys,
  newPairCode,
  openWithCode,
  packSnapshot,
  pairId,
  sealForCode,
  PHONE_FILES,
  phoneMayWrite,
  seal,
  unpackSnapshot,
  unseal,
  withPhoneId,
  type CloudOp,
  type LinkKeys,
  type PhoneOp,
  type SnapshotHeader,
} from "./sync";

// ---- Small IndexedDB store (localStorage is too small for the database) ------------

const IDB = "cc-phone";
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const d = await idb();
  return new Promise((ok, fail) => {
    const r = d.transaction("kv").objectStore("kv").get(key);
    r.onsuccess = () => ok(r.result as T | undefined);
    r.onerror = () => fail(r.error);
  });
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const d = await idb();
  return new Promise((ok, fail) => {
    const t = d.transaction("kv", "readwrite");
    t.objectStore("kv").put(value, key);
    t.oncomplete = () => ok();
    t.onerror = () => fail(t.error);
  });
}

// ---- State -------------------------------------------------------------------------

interface Pending {
  /** Local sequence number. */
  seq: number;
  op: PhoneOp;
  /** The service's id once sent. */
  id?: number;
}
interface Saved {
  db: Uint8Array;
  header: SnapshotHeader;
  version: number;
  /** The last cloud change applied on top of this copy. */
  cloudSeen?: number;
}
let cloudSeen = 0;

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let database: Database | null = null;
let header: SnapshotHeader | null = null;
let version = 0;
let pending: Pending[] = [];
let link: { secret: string; keys: LinkKeys; account?: string } | null = null;
const listeners = new EventTarget();

export const phoneState = {
  get header() {
    return header;
  },
  get version() {
    return version;
  },
  get pending() {
    return pending.filter((p) => p.id == null).length;
  },
  lastCheck: null as string | null,
  error: null as string | null,
  /** What a refresh is doing right now, for the start-up screen. */
  stage: null as string | null,
  onChange(cb: () => void) {
    listeners.addEventListener("change", cb);
    return () => listeners.removeEventListener("change", cb);
  },
};
const changed = () => listeners.dispatchEvent(new Event("change"));

/** A request to the sync service; gives up after `ms` (a hung connection on a phone otherwise waits forever). */
const api = async (path: string, init: RequestInit = {}, ms = 30_000) => {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(`/api${path}`, { ...init, signal: ctl.signal, headers: { ...(link ? { "x-cc-token": link.keys.token } : {}), ...(link?.account ? { "x-cc-account": link.account } : {}), ...(init.headers ?? {}) } });
  } catch (e) {
    if (ctl.signal.aborted) throw new Error(`Offline: the cloud didn't answer within ${Math.round(ms / 1000)} s.`);
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
};
const stage = (s: string | null) => {
  phoneState.stage = s;
  changed();
};

async function sql() {
  SQL ??= await initSqlJs({ locateFile: () => wasmUrl });
  return SQL;
}

const norm = (p: SqlParam[]) => p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as (string | number | null)[];

function run(d: Database, s: string, params: SqlParam[]): ExecResult {
  if (params.length === 0 && s.trim().replace(/;$/, "").includes(";")) d.exec(s);
  else d.run(s, norm(params));
  const changes = d.getRowsModified();
  const id = d.exec("SELECT last_insert_rowid()")[0]?.values[0][0] as number;
  return { changes, lastInsertId: id ?? 0 };
}

let saveTimer: number | undefined;
function saveSoon() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    if (database && header) idbSet("snapshot", { db: database.export(), header, version, cloudSeen } satisfies Saved).catch(() => {});
  }, 800);
}

// ---- Linking -----------------------------------------------------------------------

export async function isLinked(): Promise<boolean> {
  const secret = await idbGet<string>("secret");
  if (!secret) return false;
  link = { secret, keys: await linkKeys(secret), account: (await idbGet<string>("account")) ?? undefined };
  return true;
}

/** Signed in to an account (rather than paired with a PC)? */
export const hasAccount = () => !!link?.account;

const errorOf = async (r: Response) => ((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The sync service answered ${r.status}`;

/** Sign in with Apple (the iPhone app): opens your account, making it the first time. */
export async function signInWithApple(): Promise<{ isNew: boolean }> {
  const nonce = b64url.encode(crypto.getRandomValues(new Uint8Array(24)));
  const { identityToken } = await native().signInWithApple({ nonce });
  const r = await fetch("/api/auth/apple", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identityToken, nonce }) });
  if (!r.ok) throw new Error(await errorOf(r));
  const j = (await r.json()) as { account: string; secret: string; isNew: boolean };
  await idbSet("secret", j.secret);
  await idbSet("account", j.account);
  // A different account than before on this phone: start from its data, not the old copy.
  await idbSet("snapshot", null);
  await idbSet("pending", []);
  pending = [];
  database = null;
  header = null;
  version = 0;
  link = { secret: j.secret, keys: await linkKeys(j.secret), account: j.account };
  return { isNew: j.isNew };
}

export interface AccountInfo {
  account: string;
  created: string | null;
  garmin: boolean;
  google: boolean;
  /** The athlete's name (or true) when Strava is connected. */
  strava?: string | boolean;
  pc: boolean;
  last: { ranAt: string; errors: Record<string, string | null>; newRuns: number } | null;
}
export async function accountInfo(): Promise<AccountInfo | null> {
  if (!link?.account) return null;
  const r = await api("/account");
  if (!r.ok) throw new Error(await errorOf(r));
  return (await r.json()) as AccountInfo;
}

/** Garmin's sign-in page in the app; the ticket it ends with goes to the service, which keeps the sign-in. */
export async function connectGarmin(): Promise<void> {
  if (!link?.account) throw new Error("Sign in first.");
  const { ticket } = await native().garminLogin({ url: GARMIN_SIGN_IN });
  const r = await api("/garmin/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) }, 60_000);
  if (!r.ok) throw new Error(await errorOf(r));
}
/** Google (Calendar) for this account: Google's page in Apple's sign-in sheet; the service keeps the sign-in. */
export async function connectGoogle(): Promise<string> {
  if (!link?.account) throw new Error("Sign in first.");
  const r = await api("/google/begin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "app" }) });
  if (!r.ok) throw new Error(await errorOf(r));
  const { url } = (await r.json()) as { url: string };
  const done = new URL((await native().openAuth({ url, scheme: "commandcentre" })).url);
  if (done.searchParams.get("ok") !== "1") throw new Error(done.searchParams.get("msg") ?? "Google sign-in didn't finish.");
  return done.searchParams.get("msg") ?? "Google connected";
}
/** Strava's sign-in page (in Apple's secure sheet); the sync service keeps the tokens and fetches runs. */
export async function connectStrava(): Promise<string> {
  if (!link?.account) throw new Error("Sign in first.");
  const r = await api("/strava/begin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "app" }) });
  if (!r.ok) throw new Error(await errorOf(r));
  const { url } = (await r.json()) as { url: string };
  const done = new URL((await native().openAuth({ url, scheme: "commandcentre" })).url);
  if (done.searchParams.get("ok") !== "1") throw new Error(done.searchParams.get("msg") ?? "Strava sign-in didn't finish.");
  return done.searchParams.get("msg") ?? "Strava connected";
}
export async function disconnectStrava(): Promise<void> {
  const r = await api("/strava/disconnect", { method: "POST" });
  if (!r.ok) throw new Error(await errorOf(r));
}
export async function disconnectGoogle(): Promise<void> {
  const r = await api("/google/disconnect", { method: "POST" });
  if (!r.ok) throw new Error(await errorOf(r));
}

export async function disconnectGarmin(): Promise<void> {
  const r = await api("/garmin/disconnect", { method: "POST" });
  if (!r.ok) throw new Error(await errorOf(r));
}

/** A code for a PC to join this account (Settings → Phone & cloud on the PC), valid 15 minutes. */
export async function makeComputerCode(): Promise<{ code: string; expires: number }> {
  if (!link?.account) throw new Error("Sign in first.");
  const code = newPairCode();
  const r = await api("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ h: await pairId(code), blob: await sealForCode(code, link.secret) }) });
  if (!r.ok) throw new Error(await errorOf(r));
  return { code, expires: ((await r.json()) as { expires: number }).expires };
}

/** Deletes the account and everything in it from the sync service, then signs out here. */
export async function deleteAccount(): Promise<void> {
  const r = await api("/account/delete", { method: "POST" });
  if (!r.ok) throw new Error(await errorOf(r));
  await unpair();
}

/** A new account's first copy: the same empty tables a PC starts with, made here and sent up. */
let making: Promise<boolean> | null = null;
function makeAccountCopy(): Promise<boolean> {
  making ??= doMakeAccountCopy().finally(() => (making = null));
  return making;
}
async function doMakeAccountCopy(): Promise<boolean> {
  if (!link?.account) return false;
  stage("Setting up your account…");
  const S = await sql();
  const bytes = buildAccountDb(new S.Database());
  const today = new Date().toLocaleDateString("en-CA");
  const h = accountHeader(today);
  const box = await seal(link.keys.key, await gzip(packSnapshot(h, bytes)));
  const r = await api("/snapshot?applied=0&cloud=0", { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: box as BodyInit }, 60_000);
  if (!r.ok) throw new Error(await errorOf(r));
  await useSnapshot(bytes, h, ((await r.json()) as { version: number }).version);
  return true;
}

/** Swaps a pairing code shown on the PC for the link's secret. */
export async function pairWithCode(code: string): Promise<void> {
  const r = await fetch("/api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ h: await pairId(code) }) });
  const j = (await r.json().catch(() => ({}))) as { blob?: string; error?: string };
  if (!r.ok || !j.blob) throw new Error(j.error ?? `The sync service answered ${r.status}`);
  let secret: string;
  try {
    secret = await openWithCode(code, j.blob);
  } catch {
    throw new Error("That code didn't unlock the link. Check it, or make a new one on the PC.");
  }
  await idbSet("secret", secret);
  link = { secret, keys: await linkKeys(secret) };
}

export async function unpair() {
  await idbSet("account", null);
  await idbSet("secret", null);
  await idbSet("snapshot", null);
  await idbSet("pending", []);
  link = null;
}

// ---- Loading the PC's snapshot -----------------------------------------------------

async function useSnapshot(bytes: Uint8Array, h: SnapshotHeader, v: number) {
  const S = await sql();
  const d = new S.Database(bytes);
  // Changes not yet in this snapshot are applied again on top of it.
  pending = pending.filter((p) => p.id == null || p.id > h.applied);
  for (const p of pending) {
    for (const s of p.op.stmts ?? []) {
      try {
        run(d, s.sql, s.params);
      } catch {
        /* the row may have changed on the PC; the PC's version wins */
      }
    }
    if (p.op.file) h = { ...h, files: { ...h.files, [p.op.file.name]: p.op.file.contents } };
  }
  const old = database;
  database = d;
  header = h;
  version = v;
  old?.close();
  // Kept on the phone so it opens straight away next time; if storage is full, it still works now.
  await idbSet("pending", pending).catch(() => {});
  cloudSeen = h.cloudApplied ?? 0;
  await idbSet("snapshot", { db: d.export(), header: h, version: v, cloudSeen } satisfies Saved).catch((e) => console.warn("couldn't keep a copy on the phone", e));
}

/** Loads what's stored on the phone. False when there's nothing yet. */
export async function loadLocal(): Promise<boolean> {
  pending = (await idbGet<Pending[]>("pending")) ?? [];
  const saved = await idbGet<Saved>("snapshot");
  if (!saved?.db) return false;
  const S = await sql();
  database = new S.Database(saved.db);
  header = saved.header;
  version = saved.version;
  cloudSeen = saved.cloudSeen ?? 0;
  return true;
}

/** Fetches a newer snapshot from the service if there is one. True if the data changed. */
export async function refresh(): Promise<boolean> {
  if (!link) return false;
  try {
    stage("Sending changes made on this phone…");
    await flush().catch(() => {});
    stage("Checking the cloud for a newer copy…");
    const meta = await api("/meta");
    if (meta.status === 401) throw new Error(link.account ? "Signed out: this account was deleted or reset. Sign in again." : "This phone isn't linked any more. Link it again from Settings → Phone on the PC.");
    if (!meta.ok) throw new Error(`The sync service answered ${meta.status}`);
    const m = (await meta.json()) as { version: number };
    phoneState.lastCheck = new Date().toISOString();
    phoneState.error = null;
    // A brand-new account has no copy yet: this phone makes it.
    if (!m.version && link.account) {
      const made = await makeAccountCopy();
      stage(null);
      return made;
    }
    if (!m.version || m.version <= version) {
      const more = await pullCloud();
      stage(null);
      return more;
    }
    stage("Downloading your data from the cloud…");
    const r = await api("/snapshot", {}, 120_000);
    if (!r.ok) throw new Error(r.status === 404 ? "Nothing has been sent from the PC yet." : `The sync service answered ${r.status}`);
    const box = new Uint8Array(await r.arrayBuffer());
    stage(`Opening your data (${(box.length / 1e6).toFixed(1)} MB)…`);
    const { header: h, db } = unpackSnapshot(await gunzip(await unseal(link.keys.key, box)));
    await useSnapshot(db, h, Number(r.headers.get("x-cc-version") ?? m.version));
    await pullCloud();
    stage(null);
    return true;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    phoneState.error = /^Offline:/.test(msg) ? msg : /fetch|network|load failed/i.test(msg) ? "Offline: showing what was last synced." : msg;
    stage(null);
    return false;
  }
}

/**
 * Cloud sync: what the service fetched (new runs, health, calendar) that this
 * copy doesn't have yet, e.g. when the PC's last copy was made before it.
 */
async function pullCloud(): Promise<boolean> {
  if (!link || !header?.cloud || !database) return false;
  const after = Math.max(header.cloudApplied ?? 0, cloudSeen);
  const r = await api(`/cloudops?after=${after}`);
  if (!r.ok) return false;
  const rows = (await r.json()) as { id: number; body: string }[];
  if (!rows.length) return false;
  for (const row of rows) {
    try {
      const op = JSON.parse(new TextDecoder().decode(await unseal(link.keys.key, b64url.decode(row.body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))))) as CloudOp;
      for (const st of op.stmts) {
        // Second-by-second run data stays on the PC; opening a run fetches it when needed.
        if (!cloudMayWrite(st.sql, st.params) || /strava_full/.test(st.sql)) continue;
        try {
          run(database, st.sql, st.params);
        } catch {
          /* already there, or changed since */
        }
      }
    } catch (e) {
      console.warn("cloud change skipped", row.id, e);
    }
    cloudSeen = row.id;
  }
  saveSoon();
  return true;
}

/** Cloud sync on: asks the service to fetch from Garmin and the calendars now (no PC needed). */
export async function cloudRun(): Promise<{ newRuns: number; errors: Record<string, string | null> } | null> {
  if (!link || !header?.cloud) return null;
  const r = await api("/cloud/run", { method: "POST" }, 120_000);
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The cloud answered ${r.status}`);
  return (await r.json()) as { newRuns: number; errors: Record<string, string | null> };
}

export const cloudOn = () => !!header?.cloud;

// ---- Sending changes -----------------------------------------------------------------

let flushing: Promise<void> | null = null;
export function flush(): Promise<void> {
  flushing ??= (async () => {
    if (!link) return;
    for (const p of pending) {
      if (p.id != null) continue;
      const box = await seal(link.keys.key, new TextEncoder().encode(JSON.stringify(p.op)));
      const r = await api("/ops", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: box as BodyInit });
      if (!r.ok) throw new Error(`Couldn't send a change (${r.status})`);
      p.id = ((await r.json()) as { id: number }).id;
      await idbSet("pending", pending);
    }
    changed();
  })().finally(() => (flushing = null));
  return flushing;
}

function queue(op: PhoneOp) {
  const seq = (pending.at(-1)?.seq ?? 0) + 1;
  pending.push({ seq, op });
  idbSet("pending", pending).catch(() => {});
  changed();
  flush().catch(() => {});
}

function db(): Database {
  if (!database) throw new Error("No data on this phone yet.");
  return database;
}

/** Runs a write locally; returns the statement to send to the PC (with a phone id if it adds a row), or null. */
function localWrite(d: Database, s: string, params: SqlParam[]): { result: ExecResult; send: { sql: string; params: (string | number | null)[] } | null } {
  const p = norm(params);
  if (!phoneMayWrite(s, p)) return { result: run(d, s, params), send: null };
  const w = withPhoneId(s, p);
  return { result: run(d, w.sql, w.params), send: w };
}

const offline = (what: string) => () => Promise.reject(new Error(`offline: ${what} is updated on your PC and synced to the phone.`));

export const backend: Backend = {
  kind: "phone",
  async select<T>(s: string, params: SqlParam[] = []) {
    const stmt = db().prepare(s);
    stmt.bind(norm(params));
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as T);
    stmt.free();
    return out;
  },
  async execute(s, params = []) {
    const { result, send } = localWrite(db(), s, params);
    if (send) queue({ at: new Date().toISOString(), stmts: [send] });
    saveSoon();
    return result;
  },
  async batch(statements: Statement[]) {
    const d = db();
    d.exec("BEGIN");
    try {
      const sends: { sql: string; params: (string | number | null)[] }[] = [];
      const out = statements.map((st) => {
        const { result, send } = localWrite(d, st.sql, st.params ?? []);
        if (send) sends.push(send);
        return result;
      });
      d.exec("COMMIT");
      if (sends.length) queue({ at: new Date().toISOString(), stmts: sends });
      saveSoon();
      return out;
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  },
  async emit(event, payload) {
    window.dispatchEvent(new CustomEvent("cc:" + event, { detail: payload }));
  },
  async listen(event, cb) {
    const local = (e: Event) => cb((e as CustomEvent).detail);
    window.addEventListener("cc:" + event, local);
    return () => window.removeEventListener("cc:" + event, local);
  },
  getConfig: async () => ({ monitor: null, quickAddShortcut: "", fullscreen: false }),
  listMonitors: async () => [],
  setMonitor: async () => {},
  setFullscreen: async () => {},
  setQuickAddShortcut: async () => {},
  hideQuickAdd: async () => {},
  autostartEnabled: async () => false,
  setAutostart: async () => {},
  backupStatus: async () => ({ folder: "(on your PC)", latest: null, count: 0 }),
  backupNow: offline("Backup"),
  dataFolder: async () => "(on your PC)",
  openDataFolder: async () => {},
  appVersion: async () => "phone",

  readDataFile: async (name) => header?.files[name] ?? null,
  openAccountSignIn: async (service, session) => {
    window.open(`${service}/api/auth/apple/web/start?session=${session}`, "_blank");
  },
  openGarminActivity: async (id) => {
    window.open(`https://connect.garmin.com/modern/activity/${encodeURIComponent(id)}`, "_blank");
  },
  openStravaActivity: async (id) => {
    window.open(`https://www.strava.com/activities/${id}`, "_blank");
  },
  writeDataFile: async (name, contents) => {
    if (!header) throw new Error("No data on this phone yet.");
    header = { ...header, files: { ...header.files, [name]: contents } };
    saveSoon();
    if (PHONE_FILES.has(name)) queue({ at: new Date().toISOString(), file: { name, contents } });
  },
  // The PC is connected to these; the phone shows their synced data.
  oauthStatus: async (p) => ({ configured: !!header?.connected[p], connected: !!header?.connected[p], account: null }),
  oauthSetClient: offline("Sign-in"),
  oauthConnect: offline("Sign-in"),
  oauthDisconnect: offline("Sign-in"),
  apiRequest: offline("This"),
  icsList: async () => header?.ics ?? [],
  icsAdd: offline("Calendar"),
  icsRemove: offline("Calendar"),
  icsFetch: offline("Your calendar"),
  garminStatus: async () => ({ connected: !!header?.connected.garmin }),
  garminConnect: async () => {
    await connectGarmin();
    return { connected: true };
  },
  garminDisconnect: async () => disconnectGarmin(),
  // With cloud sync on, run details come from Garmin through the sync service.
  garminRequest: async <T,>(path: string) => {
    if (!link || !header?.cloud) throw new Error("offline: Garmin data comes from the PC");
    const r = await api(`/garmin?path=${encodeURIComponent(path)}`, {}, 45_000);
    if (!r.ok) throw new Error(`offline: ${((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `the cloud answered ${r.status}`}`);
    return (await r.json()) as { status: number; body: T };
  },
  garminWrite: async <T,>(method: string, path: string, body?: unknown) => {
    if (!link || !header?.cloud) throw new Error("offline: sending workouts from the phone needs cloud sync (switch it on in Settings → Phone on the PC)");
    const r = await api("/garmin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, path, body }) }, 45_000);
    if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `The cloud answered ${r.status}`);
    return (await r.json()) as { status: number; body: T };
  },
  cloudCredentials: offline("cloud sync settings"),
  cloudRestore: offline("cloud sync settings"),
  watchStatus: async () => ({ folder: "", serverFound: false, python: null, tokensFound: false, tokensDir: "", running: false, stderr: [] }),
  watchConnect: offline("The watch"),
  watchCall: offline("The watch"),
  watchDisconnect: async () => {},
  // Open-Meteo is public, so the phone asks it directly (current weather wherever you are).
  weatherFetch: async (lat, lon) => {
    const u =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&timezone=auto&forecast_days=3` +
      "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation" +
      "&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,weather_code,is_day" +
      "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset";
    const r = await fetch(u).catch((e) => {
      throw new Error(`offline: ${e}`);
    });
    if (!r.ok) throw new Error(`The weather service replied ${r.status}`);
    return r.json();
  },
  phoneLinkGet: async () => null,
  phoneLinkSet: async () => {},
  phoneSnapshot: async () => db().export(),
};

