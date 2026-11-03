/**
 * The phone app's backend. The dashboard's own database runs here in the
 * browser (sql.js), loaded from the PC's latest encrypted snapshot. Reading is
 * all local, so the app works offline. Changes to your own things (tasks,
 * habits, plan days, a few view settings) are applied here at once and queued
 * for the PC, which replays them on its copy and sends back a fresh snapshot.
 * Nothing on the phone talks to Strava, Google or Garmin: the PC does that.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Backend, ExecResult, SqlParam, Statement } from "./backend.types";
import {
  gunzip,
  linkKeys,
  openWithCode,
  pairId,
  PHONE_FILES,
  phoneMayWrite,
  seal,
  unpackSnapshot,
  unseal,
  withPhoneId,
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
}

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;
let database: Database | null = null;
let header: SnapshotHeader | null = null;
let version = 0;
let pending: Pending[] = [];
let link: { secret: string; keys: LinkKeys } | null = null;
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
  onChange(cb: () => void) {
    listeners.addEventListener("change", cb);
    return () => listeners.removeEventListener("change", cb);
  },
};
const changed = () => listeners.dispatchEvent(new Event("change"));

const api = (path: string, init: RequestInit = {}) =>
  fetch(`/api${path}`, { ...init, headers: { ...(link ? { "x-cc-token": link.keys.token } : {}), ...(init.headers ?? {}) } });

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
    if (database && header) idbSet("snapshot", { db: database.export(), header, version } satisfies Saved).catch(() => {});
  }, 800);
}

// ---- Linking -----------------------------------------------------------------------

export async function isLinked(): Promise<boolean> {
  const secret = await idbGet<string>("secret");
  if (!secret) return false;
  link = { secret, keys: await linkKeys(secret) };
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
  await idbSet("pending", pending);
  await idbSet("snapshot", { db: d.export(), header: h, version: v } satisfies Saved);
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
  return true;
}

/** Fetches a newer snapshot from the service if there is one. True if the data changed. */
export async function refresh(): Promise<boolean> {
  if (!link) return false;
  try {
    await flush();
    const meta = await api("/meta");
    if (meta.status === 401) throw new Error("This phone isn't linked any more. Link it again from Settings → Phone on the PC.");
    if (!meta.ok) throw new Error(`The sync service answered ${meta.status}`);
    const m = (await meta.json()) as { version: number };
    phoneState.lastCheck = new Date().toISOString();
    phoneState.error = null;
    if (!m.version || m.version <= version) {
      changed();
      return false;
    }
    const r = await api("/snapshot");
    if (!r.ok) throw new Error(r.status === 404 ? "Nothing has been sent from the PC yet." : `The sync service answered ${r.status}`);
    const box = new Uint8Array(await r.arrayBuffer());
    const { header: h, db } = unpackSnapshot(await gunzip(await unseal(link.keys.key, box)));
    await useSnapshot(db, h, Number(r.headers.get("x-cc-version") ?? m.version));
    changed();
    return true;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    phoneState.error = /fetch|network|load failed/i.test(msg) ? "Offline: showing what was last synced." : msg;
    changed();
    return false;
  }
}

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
  garminConnect: offline("Garmin"),
  garminDisconnect: offline("Garmin"),
  garminRequest: offline("Garmin data"),
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

