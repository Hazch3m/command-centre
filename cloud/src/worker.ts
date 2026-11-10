/**
 * Pacelife sync service (Cloudflare Worker + one SQLite Durable Object).
 *
 * Holds three things, all encrypted by the PC or phone before they arrive:
 *  - the PC's latest snapshot (the dashboard's database), in chunks
 *  - changes made on the phone, waiting for the PC to apply them
 *  - a short-lived pairing entry while a phone is being linked
 *  - when you switch on "sync in the cloud": your Garmin and Google sign-ins and
 *    the link's secret, so it can fetch new runs, health and calendar every
 *    15 minutes with the PC off (cloudSync.ts). Switching it off deletes them.
 * Access needs the token derived from the link's secret; only its hash is kept.
 * The first PC to "claim" the service sets that hash.
 *
 * Accounts (Sign in with Apple on the iPhone app): each person gets a store of
 * their own, picked by the x-cc-account header. The service makes the link's
 * secret and keeps it (like cloud sync), fetches from Garmin itself and applies
 * changes made on the phone, so no PC is needed. A PC can join with a code
 * made on the phone (the "directory" store finds the account for a code).
 */
import { DurableObject } from "cloudflare:workers";
import { garminExchangeTicket, garminGet, type Creds } from "./appBackend";
import { verifyAppleToken } from "./apple";
import { gzip, linkKeys, newSecret, packSnapshot, seal, type PhoneOp } from "../../src/core/sync";
import { accountHeader, buildAccountDb } from "../../src/core/account";
import { runCloudSync, type SyncResult } from "./cloudSync";
// The same (browser) build of sql.js the phone runs; the Node build would look for Node's files.
import initSqlJs, { type SqlJsStatic } from "sql.js";
import wasmModule from "sql.js/dist/sql-wasm.wasm";

let SQL: Promise<SqlJsStatic> | null = null;
// sql.js sees Workers' WorkerGlobalScope, takes itself for a browser worker and reads self.location.href,
// which Workers don't have. Give it one (the WebAssembly is bundled, so the address is never fetched).
if (!(globalThis as { location?: unknown }).location) Object.defineProperty(globalThis, "location", { value: new URL("https://command-centre.invalid/"), configurable: true });
/** sql.js with its WebAssembly bundled into the service (Workers can't fetch it at run time). */
const sqlJs = () =>
  (SQL ??= initSqlJs({
    instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => {
      WebAssembly.instantiate(wasmModule as WebAssembly.Module, imports).then((inst) => done(inst));
      return {};
    },
  }) as Promise<SqlJsStatic>);

interface Env {
  STORE: DurableObjectNamespace<Store>;
  ASSETS: Fetcher;
  /** Set only for a moment by the "Reset sync service" workflow (Actions), to wipe a service nobody can reach any more. */
  RESET_KEY?: string;
  /** Google sign-in for accounts (a "Web application" OAuth client), set from GitHub secrets on deploy. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Pacelife's Strava API app (strava.com/settings/api), set from GitHub secrets on deploy. */
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
}

/** Sign in with Apple on the web (the PC): the Services ID set up for it in the Apple developer account. */
const APPLE_WEB_ID = "com.hazch3m.commandcentre.web";
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks";
const page = (title: string, text: string, status = 200) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:17px -apple-system,system-ui,sans-serif;background:#252a31;color:#e8eaed;display:grid;place-items:center;min-height:90vh;text-align:center;padding:1rem"><div><h2>${title}</h2><p>${text}</p></div></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );

const CHUNK = 1_500_000; // under the 2 MB per-value limit
const MAX_SNAPSHOT = 60_000_000;
const MAX_OP = 2_000_000;
const PAIR_TTL = 15 * 60_000;
const PAIR_FAILS = 10; // wrong codes allowed per 15 minutes

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, x-cc-token, x-cc-account",
  "access-control-expose-headers": "x-cc-version, x-cc-applied",
  "access-control-max-age": "86400",
};

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...CORS } });
const err = (status: number, message: string) => json({ error: message }, status);

async function sha256hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Store extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snap (i INTEGER PRIMARY KEY, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ops (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS pair (h TEXT PRIMARY KEY, blob TEXT NOT NULL, expires INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS fails (at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cloudops (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, body BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS dir (h TEXT PRIMARY KEY, account TEXT NOT NULL, expires INTEGER NOT NULL);
    `);
  }

  private get(k: string): string | null {
    const r = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = ?", k).toArray();
    return r[0]?.v ?? null;
  }
  private set(k: string, v: string) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private async authed(req: Request): Promise<boolean> {
    const token = req.headers.get("x-cc-token");
    const want = this.get("tokenHash");
    return !!token && !!want && (await sha256hex(token)) === want;
  }

  /** An account's own store (not the PC-owned one). */
  private isAccount() {
    return !!this.get("account");
  }

  /** Forgets everything: the claim, the copy, phone links and changes, cloud sync and its sign-ins. */
  private async wipe() {
    this.ctx.storage.transactionSync(() => {
      for (const t of ["snap", "ops", "pair", "fails", "cloudops", "meta"]) this.sql.exec(`DELETE FROM ${t}`);
    });
    await this.ctx.storage.deleteAlarm();
  }

  private putSnapshot(body: Uint8Array, applied: number, cloudApplied: number): number {
    const version = Math.max(Date.now(), Number(this.get("snapVersion") ?? 0) + 1);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM snap");
      for (let i = 0, n = 0; i < body.length; i += CHUNK, n++) this.sql.exec("INSERT INTO snap (i, data) VALUES (?, ?)", n, body.slice(i, i + CHUNK).buffer);
      this.set("snapVersion", String(version));
      this.set("snapApplied", String(applied));
      this.set("snapCloud", String(cloudApplied));
      this.set("snapSize", String(body.length));
    });
    return version;
  }

  private readSnapshot(): Uint8Array | null {
    const parts = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM snap ORDER BY i").toArray();
    if (!parts.length) return null;
    const out = new Uint8Array(parts.reduce((a, p) => a + p.data.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      out.set(new Uint8Array(p.data), o);
      o += p.data.byteLength;
    }
    return out;
  }

  // ---- Sync in the cloud -----------------------------------------------------------

  private creds(): Creds | null {
    const c = this.get("creds");
    return c ? (JSON.parse(c) as Creds) : null;
  }

  private syncing: Promise<SyncResult> | null = null;
  private again = false;

  /** A change arrived from the phone: apply it to the account's copy soon (and update the watch). */
  private applySoon() {
    if (this.syncing) {
      this.again = true;
      return;
    }
    this.ctx.waitUntil(this.runSync(false, ["watch"]).catch(() => null));
  }

  /** Something for the 15-minute sync to fetch? */
  private hasSources(c: Creds | null) {
    return !!c && (!!c.garmin || !!c.google || !!c.strava || c.ics.length > 0);
  }

  /** One cloud sync (one at a time). Calendars at most hourly: they're rewritten in full each time. */
  private runSync(force = false, onlyThese?: ("runs" | "health" | "calendar" | "watch")[]): Promise<SyncResult> {
    this.syncing ??= (async () => {
      const creds = this.creds();
      if (!creds) return { ranAt: new Date().toISOString(), wrote: 0, errors: { cloud: "Cloud sync is off." }, newRuns: 0 };
      const calAt = Number(this.get("cloudCalAt") ?? 0);
      const withCal = force || Date.now() - calAt > 55 * 60_000;
      const io = {
        creds,
        sqlJs,
        account: this.isAccount(),
        phoneOpsAfter: (id: number) => this.sql.exec<{ id: number; body: ArrayBuffer }>("SELECT id, body FROM ops WHERE id > ? ORDER BY id LIMIT 500", id).toArray().map((r) => ({ id: r.id, body: new Uint8Array(r.body) })),
        saveCreds: async (c: Creds) => this.set("creds", JSON.stringify(c)),
        loadSnapshot: async () => {
          const box = this.readSnapshot();
          return box ? { box, version: Number(this.get("snapVersion") ?? 0), applied: Number(this.get("snapApplied") ?? 0) } : null;
        },
        saveSnapshot: async (box: Uint8Array, applied: number, cloudApplied: number, ifVersion: number) => {
          // The PC sent a newer copy while this ran: keep it; the changes are in the cloud log for everyone to replay.
          if (Number(this.get("snapVersion") ?? 0) !== ifVersion) return false;
          this.putSnapshot(box, applied, cloudApplied);
          return true;
        },
        cloudOpsAfter: (id: number) => this.sql.exec<{ id: number; body: ArrayBuffer }>("SELECT id, body FROM cloudops WHERE id > ? ORDER BY id", id).toArray().map((r) => ({ id: r.id, body: new Uint8Array(r.body) })),
        addCloudOp: (body: Uint8Array) => this.sql.exec<{ id: number }>("INSERT INTO cloudops (at, body) VALUES (?, ?) RETURNING id", Date.now(), body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)).one().id,
      };
      let r: SyncResult;
      try {
        r = await runCloudSync(io, onlyThese ?? (withCal ? undefined : ["runs", "health", "watch"]), force);
        if (withCal && !onlyThese) this.set("cloudCalAt", String(Date.now()));
      } catch (e) {
        r = { ranAt: new Date().toISOString(), wrote: 0, errors: { cloud: String((e as Error)?.message ?? e) }, newRuns: 0 };
      }
      this.set("cloudLast", JSON.stringify(r));
      // Old changes everyone has: the PC applied them and the phone's copy includes them.
      const pcAck = Number(this.get("cloudAck") ?? 0);
      const inSnap = Number(this.get("snapCloud") ?? 0);
      this.sql.exec("DELETE FROM cloudops WHERE id <= ? AND at < ?", Math.min(pcAck, inSnap), Date.now() - 86400_000);
      // An account with no PC: changes already in the saved copy are kept 60 days (so a PC joining later still
      // gets them), then dropped.
      if (this.isAccount() && this.get("pcLinked") !== "1") {
        const old = Date.now() - 60 * 86400_000;
        this.sql.exec("DELETE FROM ops WHERE id <= ? AND at < ?", Number(this.get("snapApplied") ?? 0), old);
        this.sql.exec("DELETE FROM cloudops WHERE id <= ? AND at < ?", Number(this.get("snapCloud") ?? 0), old);
      }
      return r;
    })().finally(() => {
      this.syncing = null;
      if (this.again) {
        this.again = false;
        this.applySoon();
      }
    });
    return this.syncing;
  }

  async alarm() {
    if (!this.hasSources(this.creds())) return;
    try {
      await this.runSync();
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + 15 * 60_000);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const m = req.method;

    // ---- From the service itself (never reachable from outside: the front door refuses /internal) ----
    if (path.startsWith("/internal/")) {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (path === "/internal/login") {
        // Signed in with Apple (already checked): open the account, making it the first time.
        let isNew = false;
        if (!this.isAccount()) {
          const secret = newSecret();
          const { token } = await linkKeys(secret);
          this.set("tokenHash", await sha256hex(token));
          this.set("creds", JSON.stringify({ secret, garmin: null, google: null, ics: [] } satisfies Creds));
          this.set("account", String(body.account));
          this.set("created", new Date().toISOString());
          isNew = true;
        }
        if (this.get("owner") !== body.sub) this.set("owner", String(body.sub));
        return json({ account: this.get("account"), secret: this.creds()!.secret, isNew });
      }
      if (path === "/internal/dir/put") {
        this.sql.exec("DELETE FROM dir WHERE expires < ? OR account = ?", Date.now(), String(body.account));
        this.sql.exec("INSERT OR REPLACE INTO dir (h, account, expires) VALUES (?, ?, ?)", String(body.h), String(body.account), Date.now() + PAIR_TTL);
        return json({ ok: true });
      }
      if (path === "/internal/session/put") {
        // Sign in with Apple on the PC: the result waits here (5 minutes) for the PC to collect it once.
        this.sql.exec("DELETE FROM dir WHERE expires < ?", Date.now());
        this.sql.exec("INSERT OR REPLACE INTO dir (h, account, expires) VALUES (?, ?, ?)", "s:" + String(body.session), JSON.stringify(body.result), Date.now() + 5 * 60_000);
        return json({ ok: true });
      }
      if (path === "/internal/session/take") {
        const key = "s:" + String(body.session);
        const row = this.sql.exec<{ account: string; expires: number }>("SELECT account, expires FROM dir WHERE h = ?", key).toArray()[0];
        if (!row || row.expires < Date.now()) return err(404, "not yet");
        this.sql.exec("DELETE FROM dir WHERE h = ?", key);
        return new Response(row.account, { headers: { "content-type": "application/json", ...CORS } });
      }
      if (path === "/internal/strava/finish") {
        // Strava's sign-in came back for this account: swap the code for tokens and keep them for run sync.
        const want = this.get("stravaState") ?? "";
        this.set("stravaState", "");
        if (!want || want !== body.state || Number(this.get("stravaStateAt") ?? 0) < Date.now() - 15 * 60_000) return err(400, "This sign-in has expired. Start it again in the app.");
        if (!/activity:read/.test(String(body.scope ?? ""))) return err(400, "Pacelife needs to see your activities: connect again and leave \"View data about your activities\" ticked.");
        const env = this.env as Env;
        const r = await fetch("https://www.strava.com/oauth/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID!, client_secret: env.STRAVA_CLIENT_SECRET!, code: String(body.code), grant_type: "authorization_code" }),
        });
        const t = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_at?: number; athlete?: { firstname?: string; lastname?: string }; message?: string; errors?: unknown };
        if (!t.access_token || !t.refresh_token) return err(502, `Strava didn't finish the sign-in: ${t.message ?? r.status}`);
        const c = this.creds();
        if (!c) return err(409, "Account not found.");
        const athlete = [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(" ") || null;
        const strava = { client: { id: env.STRAVA_CLIENT_ID!, secret: env.STRAVA_CLIENT_SECRET! }, token: { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: t.expires_at ?? Math.floor(Date.now() / 1000) + 6 * 3600, athlete } };
        this.set("creds", JSON.stringify({ ...c, strava } satisfies Creds));
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ ok: true, athlete });
      }
      if (path === "/internal/google/finish") {
        // Google's sign-in came back for this account: swap the code for tokens and keep them for calendar sync.
        const want = this.get("googleState") ?? "";
        this.set("googleState", "");
        if (!want || want !== body.state || Number(this.get("googleStateAt") ?? 0) < Date.now() - 15 * 60_000) return err(400, "This sign-in has expired. Start it again in the app.");
        const env = this.env as Env;
        const r = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ code: String(body.code), client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: String(body.redirect), grant_type: "authorization_code" }),
        });
        const t = (await r.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string; error_description?: string };
        if (!t.access_token) return err(502, `Google didn't finish the sign-in: ${t.error_description ?? r.status}`);
        let email: string | null = null;
        try {
          email = JSON.parse(atob(String(t.id_token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email ?? null;
        } catch {
          /* no email: fine */
        }
        const c = this.creds();
        if (!c) return err(409, "Account not found.");
        const google = { client: { id: env.GOOGLE_CLIENT_ID!, secret: env.GOOGLE_CLIENT_SECRET! }, token: { access_token: t.access_token, refresh_token: t.refresh_token ?? c.google?.token.refresh_token ?? null, expires_at: Math.floor(Date.now() / 1000) + (t.expires_in ?? 3600), account: email } };
        this.set("creds", JSON.stringify({ ...c, google } satisfies Creds));
        this.set("cloudCalAt", "0");
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ ok: true, email });
      }
      if (path === "/internal/dir/get") {
        const now = Date.now();
        this.sql.exec("DELETE FROM fails WHERE at < ?", now - PAIR_TTL);
        this.sql.exec("DELETE FROM dir WHERE expires < ?", now);
        if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fails").one().n >= PAIR_FAILS * 5) return err(429, "Too many wrong codes. Wait 15 minutes, then make a new code on the phone.");
        const row = this.sql.exec<{ account: string }>("SELECT account FROM dir WHERE h = ?", String(body.h)).toArray()[0];
        if (!row) {
          this.sql.exec("INSERT INTO fails (at) VALUES (?)", now);
          return err(404, "That code isn't right, or it has expired. Make a new one in the app (More → Account → Link a computer).");
        }
        return json({ account: row.account });
      }
      return err(404, "unknown request");
    }

    // ---- No token needed --------------------------------------------------------
    if (path === "/health") return json({ ok: true, claimed: !!this.get("tokenHash") });

    if (path === "/claim" && m === "POST") {
      // Set the access token the first time; afterwards only the same token (or a rotation, below) works.
      const { token } = (await req.json()) as { token?: string };
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return err(400, "bad token");
      const h = await sha256hex(token);
      const have = this.get("tokenHash");
      if (have && have !== h) return err(409, "This sync service is already linked to another Pacelife.");
      this.set("tokenHash", h);
      return json({ ok: true });
    }

    if (path === "/admin-reset" && m === "POST") {
      const key = (this.env as Env).RESET_KEY ?? "";
      const given = req.headers.get("x-cc-reset") ?? "";
      if (key.length < 32 || given.length !== key.length || (await sha256hex(given)) !== (await sha256hex(key))) return err(403, "no");
      await this.wipe();
      return json({ ok: true, reset: true });
    }

    if (path === "/pair/redeem" && m === "POST") {
      const now = Date.now();
      this.sql.exec("DELETE FROM fails WHERE at < ?", now - PAIR_TTL);
      this.sql.exec("DELETE FROM pair WHERE expires < ?", now);
      const fails = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM fails").one().n;
      if (fails >= PAIR_FAILS) return err(429, "Too many wrong codes. Wait 15 minutes, then make a new code on the PC.");
      const { h } = (await req.json()) as { h?: string };
      const row = h ? this.sql.exec<{ blob: string; uses: number }>("SELECT blob, uses FROM pair WHERE h = ?", h).toArray()[0] : undefined;
      if (!row || row.uses >= 3) {
        this.sql.exec("INSERT INTO fails (at) VALUES (?)", now);
        return err(404, "That code isn't right, or it has expired. Make a new one on the PC.");
      }
      this.sql.exec("UPDATE pair SET uses = uses + 1 WHERE h = ?", h);
      return json({ blob: row.blob });
    }

    if (!(await this.authed(req))) return err(401, "Not linked. Pair this device from Pacelife on your PC.");

    // ---- PC and phone --------------------------------------------------------------
    if (path === "/meta" && m === "GET") {
      const last = this.sql.exec<{ id: number | null }>("SELECT MAX(id) AS id FROM ops").one().id ?? 0;
      return json({
        version: Number(this.get("snapVersion") ?? 0),
        applied: Number(this.get("snapApplied") ?? 0),
        size: Number(this.get("snapSize") ?? 0),
        pendingOps: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ops").one().n,
        lastOp: last,
      });
    }

    if (path === "/snapshot" && m === "PUT") {
      const body = new Uint8Array(await req.arrayBuffer());
      if (!body.length || body.length > MAX_SNAPSHOT) return err(413, "snapshot too large");
      const applied = Number(url.searchParams.get("applied") ?? 0);
      const version = this.putSnapshot(body, applied, Number(url.searchParams.get("cloud") ?? 0));
      return json({ version });
    }

    if (path === "/snapshot" && m === "GET") {
      const out = this.readSnapshot();
      if (!out) return err(404, "Nothing synced from the PC yet.");
      return new Response(out, {
        headers: { "content-type": "application/octet-stream", "x-cc-version": this.get("snapVersion") ?? "0", "x-cc-applied": this.get("snapApplied") ?? "0", "cache-control": "no-store", ...CORS },
      });
    }

    // ---- Sync in the cloud -------------------------------------------------------------
    // ---- Accounts ------------------------------------------------------------------------
    if (path === "/account" && m === "GET") {
      const c = this.creds();
      return json({ account: this.get("account"), created: this.get("created"), garmin: !!c?.garmin, google: !!c?.google, strava: c?.strava ? (c.strava.token.athlete ?? true) : false, pc: this.get("pcLinked") === "1", hasData: !!this.get("snapVersion"), last: this.get("cloudLast") ? JSON.parse(this.get("cloudLast")!) : null });
    }
    if (path === "/account/delete" && m === "POST") {
      if (!this.isAccount()) return err(409, "Not an account.");
      await this.wipe();
      return json({ ok: true, deleted: true });
    }
    if (path === "/garmin/connect" && m === "POST") {
      // The iPhone app signed in on Garmin's page and hands over the ticket Garmin gave it.
      const c = this.creds();
      if (!c) return err(409, "Cloud sync is off.");
      const { ticket } = (await req.json()) as { ticket?: string };
      try {
        const garmin = await garminExchangeTicket(String(ticket ?? ""));
        this.set("creds", JSON.stringify({ ...c, garmin } satisfies Creds));
      } catch (e) {
        return err(502, String((e as Error)?.message ?? e));
      }
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true });
    }
    if (path === "/google/begin" && m === "POST") {
      // Starts Google sign-in for this account (Calendar): returns the address of Google's page.
      const env = this.env as Env;
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return err(501, "Google sign-in isn't set up on the sync service yet (add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the GitHub secrets).");
      const account = this.get("account");
      if (!account) return err(409, "Only for accounts.");
      const { from } = (await req.json().catch(() => ({}))) as { from?: string };
      const state = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
      this.set("googleState", state);
      this.set("googleStateAt", String(Date.now()));
      const redirect = `${url.origin}/api/oauth/google/callback`;
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [k, v] of Object.entries({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: `openid email ${GOOGLE_SCOPES}`, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state: `${account}.${state}.${from === "app" ? "app" : "web"}` })) u.searchParams.set(k, v);
      return json({ url: u.toString() });
    }
    if (path === "/strava/begin" && m === "POST") {
      // Starts Strava sign-in for this account: returns the address of Strava's page.
      const env = this.env as Env;
      if (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET) return err(501, "Strava isn't set up on the sync service yet (add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET to the GitHub secrets).");
      const account = this.get("account");
      if (!account) return err(409, "Only for accounts.");
      const { from } = (await req.json().catch(() => ({}))) as { from?: string };
      const state = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
      this.set("stravaState", state);
      this.set("stravaStateAt", String(Date.now()));
      const u = new URL("https://www.strava.com/oauth/authorize");
      for (const [k, v] of Object.entries({ client_id: env.STRAVA_CLIENT_ID, redirect_uri: `${url.origin}/api/oauth/strava/callback`, response_type: "code", approval_prompt: "auto", scope: "read,activity:read_all,profile:read_all", state: `${account}.${state}.${from === "app" ? "app" : "web"}` })) u.searchParams.set(k, v);
      return json({ url: u.toString() });
    }
    if (path === "/strava/disconnect" && m === "POST") {
      const c = this.creds();
      if (c?.strava) {
        // Tell Strava too, so Pacelife's access is gone on their side.
        await fetch("https://www.strava.com/oauth/deauthorize", { method: "POST", headers: { Authorization: `Bearer ${c.strava.token.access_token}` } }).catch(() => {});
        this.set("creds", JSON.stringify({ ...c, strava: null } satisfies Creds));
      }
      return json({ ok: true });
    }
    if (path === "/google/disconnect" && m === "POST") {
      const c = this.creds();
      if (c) this.set("creds", JSON.stringify({ ...c, google: null } satisfies Creds));
      return json({ ok: true });
    }

    if (path === "/garmin/disconnect" && m === "POST") {
      const c = this.creds();
      if (c) this.set("creds", JSON.stringify({ ...c, garmin: null } satisfies Creds));
      return json({ ok: true });
    }

    if (path === "/release" && m === "POST") {
      // An account stays: this PC just leaves it.
      if (this.isAccount()) {
        this.set("pcLinked", "");
        return json({ ok: true });
      }
      // "Disconnect" on the PC: free the service so a PC can connect afresh.
      await this.wipe();
      return json({ ok: true });
    }

    if (path === "/cloud/enable" && m === "POST") {
      const c = (await req.json()) as Creds & { fresh?: boolean };
      if (!c?.secret || typeof c.secret !== "string") return err(400, "bad credentials");
      if (this.isAccount()) {
        // A PC joining an account: its sign-ins are added to the account's (a Garmin one signed in on the phone stays).
        const have = this.creds();
        if (have && c.secret !== have.secret) return err(403, "That isn't this account's link.");
        // A sign-in just made on the PC ("fresh") replaces the account's; when joining, the account's (maybe
        // newer, signed in on the phone) is kept and the PC's only fills a gap. Garmin's tokens rotate, so an
        // older copy may no longer work.
        const pick = <T,>(mine: T | null | undefined, theirs: T | null | undefined) => (c.fresh ? (theirs ?? mine) : (mine ?? theirs)) ?? null;
        this.set("creds", JSON.stringify({ secret: have?.secret ?? c.secret, garmin: pick(have?.garmin, c.garmin), google: pick(have?.google, c.google), strava: have?.strava ?? null, ics: Array.isArray(c.ics) && c.ics.length ? c.ics : (have?.ics ?? []) } satisfies Creds));
        this.set("pcLinked", "1");
        this.set("cloudCalAt", "0");
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return json({ ok: true });
      }
      this.set("creds", JSON.stringify({ secret: c.secret, garmin: c.garmin ?? null, google: c.google ?? null, strava: this.creds()?.strava ?? null, ics: Array.isArray(c.ics) ? c.ics : [] }));
      this.set("cloudCalAt", "0");
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true });
    }
    if (path === "/cloud/disable" && m === "POST") {
      if (this.isAccount()) return err(409, "An account always syncs in the cloud. To stop, leave the account (Disconnect) instead.");
      // Hand the (possibly refreshed) sign-ins back to the PC, then forget them here.
      const c = this.creds();
      this.set("creds", "");
      await this.ctx.storage.deleteAlarm();
      return json({ garmin: c?.garmin ?? null, google: c?.google?.token ?? null });
    }
    if (path === "/cloud/status" && m === "GET") {
      const c = this.creds();
      const last = this.get("cloudLast");
      return json({ enabled: !!c, garmin: !!c?.garmin, google: !!c?.google, ics: c?.ics.length ?? 0, last: last ? JSON.parse(last) : null, next: await this.ctx.storage.getAlarm() });
    }
    if (path === "/cloud/run" && m === "POST") {
      if (!this.creds()) return err(409, "Cloud sync is off.");
      // At most once a minute (the phone's refresh button), unless one is running: then wait for it.
      const last = this.get("cloudLast");
      const ranAt = last ? Date.parse((JSON.parse(last) as SyncResult).ranAt) : 0;
      if (!this.syncing && Date.now() - ranAt < 60_000) return json({ ...(JSON.parse(last!) as SyncResult), recent: true });
      return json(await this.runSync(true));
    }
    if (path === "/cloudops" && m === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const rows = this.sql.exec<{ id: number; at: number; body: ArrayBuffer }>("SELECT id, at, body FROM cloudops WHERE id > ? ORDER BY id LIMIT 100", after).toArray();
      return json(rows.map((r) => ({ id: r.id, at: r.at, body: b64(new Uint8Array(r.body)) })));
    }
    if (path === "/cloudops/ack" && m === "POST") {
      const { upto } = (await req.json()) as { upto?: number };
      if (typeof upto === "number") this.set("cloudAck", String(upto));
      return json({ ok: true });
    }
    if (path === "/garmin" && m === "POST") {
      // Workouts to the watch, from the phone or the PC, with the cloud's Garmin sign-in.
      const c = this.creds();
      if (!c?.garmin) return err(409, "Garmin isn't in the cloud.");
      const { method, path: p, body } = (await req.json()) as { method?: string; path?: string; body?: unknown };
      if (method !== "POST" && method !== "PUT" && method !== "DELETE") return err(400, "bad method");
      const io = { creds: c, saveCreds: async (n: Creds) => this.set("creds", JSON.stringify(n)) };
      try {
        return json(await garminGet(io, p ?? "", method, body));
      } catch (e) {
        return err(502, String((e as Error)?.message ?? e));
      }
    }
    if (path === "/garmin" && m === "GET") {
      // Garmin for the PC and the phone while the cloud holds the sign-in (one place refreshes it, so it never clashes).
      const c = this.creds();
      if (!c?.garmin) return err(409, "Garmin isn't in the cloud.");
      const io = { creds: c, saveCreds: async (n: Creds) => this.set("creds", JSON.stringify(n)) };
      try {
        return json(await garminGet(io, url.searchParams.get("path") ?? ""));
      } catch (e) {
        return err(502, String((e as Error)?.message ?? e));
      }
    }

    if (path === "/ops" && m === "POST") {
      const body = await req.arrayBuffer();
      if (!body.byteLength || body.byteLength > MAX_OP) return err(413, "change too large");
      const id = this.sql.exec<{ id: number }>("INSERT INTO ops (at, body) VALUES (?, ?) RETURNING id", Date.now(), body).one().id;
      if (this.isAccount()) this.applySoon();
      return json({ id });
    }

    if (path === "/ops" && m === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const rows = this.sql.exec<{ id: number; at: number; body: ArrayBuffer }>("SELECT id, at, body FROM ops WHERE id > ? ORDER BY id LIMIT 200", after).toArray();
      return json(rows.map((r) => ({ id: r.id, at: r.at, body: b64(new Uint8Array(r.body)) })));
    }

    if (path === "/ops/ack" && m === "POST") {
      const { upto } = (await req.json()) as { upto?: number };
      if (typeof upto === "number") this.sql.exec("DELETE FROM ops WHERE id <= ?", upto);
      return json({ ok: true });
    }

    if (path === "/pair" && m === "POST") {
      // PC: leave the secret here, encrypted with the pairing code, for 15 minutes.
      const { h, blob } = (await req.json()) as { h?: string; blob?: string };
      if (!h || !blob) return err(400, "bad pairing");
      this.sql.exec("DELETE FROM pair");
      this.sql.exec("INSERT INTO pair (h, blob, expires) VALUES (?, ?, ?)", h, blob, Date.now() + PAIR_TTL);
      // An account's code (made on the phone for a PC): the directory finds this account from it.
      const account = this.get("account");
      if (account) await this.env.STORE.get(this.env.STORE.idFromName("directory")).fetch("https://cc/internal/dir/put", { method: "POST", body: JSON.stringify({ h, account }) });
      return json({ expires: Date.now() + PAIR_TTL });
    }

    if (path === "/rotate" && m === "POST") {
      if (this.isAccount()) return err(409, "An account's link can't be replaced from here.");
      // PC: replace the access token (unlinks every phone).
      const { token } = (await req.json()) as { token?: string };
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return err(400, "bad token");
      this.ctx.storage.transactionSync(() => {
        this.set("tokenHash", "");
        this.sql.exec("DELETE FROM snap");
        this.sql.exec("DELETE FROM ops");
        this.sql.exec("DELETE FROM pair");
        this.sql.exec("DELETE FROM cloudops");
        this.set("creds", "");
      });
      await this.ctx.storage.deleteAlarm();
      this.set("tokenHash", await sha256hex(token));
      return json({ ok: true });
    }

    return err(404, "unknown request");
  }
}

/**
 * Checks, on Cloudflare itself, that a whole account sync works: SQLite, the app's tables, encryption,
 * compression, and applying a phone change. Run after every deploy (GitHub Actions); holds no data.
 */
async function selfTest(): Promise<{ ok: boolean; steps: string[]; error?: string }> {
  const steps: string[] = [];
  try {
    const S = await sqlJs();
    steps.push("sqlite");
    const bytes = buildAccountDb(new S.Database());
    steps.push("tables");
    const secret = newSecret();
    const keys = await linkKeys(secret);
    let snap = { box: await seal(keys.key, await gzip(packSnapshot(accountHeader("2026-01-01"), bytes))), version: 1, applied: 0 };
    steps.push("sealed");
    const op: PhoneOp = { at: "now", stmts: [{ sql: "INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)", params: [1, "self-test", "2026-01-01T00:00:00Z"] }] };
    const opBox = await seal(keys.key, new TextEncoder().encode(JSON.stringify(op)));
    const r = await runCloudSync(
      {
        account: true,
        sqlJs,
        creds: { secret, garmin: null, google: null, ics: [] },
        saveCreds: async () => {},
        loadSnapshot: async () => snap,
        saveSnapshot: async (box, applied, _c, v) => ((snap = { box, version: v + 1, applied }), true),
        cloudOpsAfter: () => [],
        addCloudOp: () => 1,
        phoneOpsAfter: (id) => (id < 1 ? [{ id: 1, body: opBox }] : []),
      },
      ["watch"],
    );
    if (r.errors.cloud) throw new Error(r.errors.cloud);
    if (r.applied !== 1 || snap.version !== 2) throw new Error(`phone change not applied (applied ${r.applied})`);
    steps.push("account sync");
    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, error: String((e as Error)?.stack ?? e) };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (url.pathname === "/api/selftest") {
        const t = await selfTest();
        return json(t, t.ok ? 200 : 500);
      }
      if (url.pathname.startsWith("/api/internal/")) return err(404, "unknown request");
      const store = (name: string) => env.STORE.get(env.STORE.idFromName(name));

      if (url.pathname === "/api/auth/apple" && req.method === "POST") {
        // Sign in with Apple from the iPhone app: check Apple's token, then open (or make) that person's account.
        const { identityToken, nonce } = (await req.json().catch(() => ({}))) as { identityToken?: string; nonce?: string };
        let who: Awaited<ReturnType<typeof verifyAppleToken>>;
        try {
          who = await verifyAppleToken(String(identityToken ?? ""), String(nonce ?? ""));
        } catch (e) {
          return err(401, `Sign in with Apple didn't work: ${(e as Error).message}`);
        }
        const account = await sha256hex("cc-apple:" + who.sub);
        return store("acct:" + account).fetch("https://cc/internal/login", { method: "POST", body: JSON.stringify({ account, sub: who.sub }) });
      }

      if (url.pathname === "/api/oauth/strava/callback" && req.method === "GET") {
        // Strava's sign-in comes back here, then on to the app (or a page saying you can close the browser).
        const [account, state, from] = (url.searchParams.get("state") ?? "").split(".");
        const done = (ok: boolean, msg: string) =>
          from === "app" ? Response.redirect(`commandcentre://auth-done?ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`, 302) : page(ok ? "Strava connected" : "Strava sign-in didn't finish", ok ? "Your runs now come into Pacelife. You can close this tab." : msg, ok ? 200 : 400);
        if (url.searchParams.get("error")) return done(false, url.searchParams.get("error") === "access_denied" ? "You cancelled on Strava's page." : `Strava said: ${url.searchParams.get("error")}`);
        if (!/^[0-9a-f]{64}$/.test(account ?? "") || !state) return done(false, "This sign-in link is broken. Start it again.");
        const r = await store("acct:" + account).fetch("https://cc/internal/strava/finish", { method: "POST", body: JSON.stringify({ state, code: url.searchParams.get("code"), scope: url.searchParams.get("scope") }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string; athlete?: string };
        return done(r.ok, r.ok ? `Strava connected${j.athlete ? ` as ${j.athlete}` : ""}` : (j.error ?? "Strava sign-in failed"));
      }

      if (url.pathname === "/api/oauth/google/callback" && req.method === "GET") {
        // Google's sign-in comes back here, then on to the app (or a page saying you can close the browser).
        const [account, state, from] = (url.searchParams.get("state") ?? "").split(".");
        const done = (ok: boolean, msg: string) =>
          from === "app" ? Response.redirect(`commandcentre://auth-done?ok=${ok ? 1 : 0}&msg=${encodeURIComponent(msg)}`, 302) : page(ok ? "Google connected" : "Google sign-in didn't finish", ok ? "Your calendar now syncs to Pacelife. You can close this tab." : msg, ok ? 200 : 400);
        if (url.searchParams.get("error")) return done(false, `Google said: ${url.searchParams.get("error")}`);
        if (!/^[0-9a-f]{64}$/.test(account ?? "") || !state) return done(false, "This sign-in link is broken. Start it again.");
        const r = await store("acct:" + account).fetch("https://cc/internal/google/finish", { method: "POST", body: JSON.stringify({ state, code: url.searchParams.get("code"), redirect: `${url.origin}/api/oauth/google/callback` }) });
        const j = (await r.json().catch(() => ({}))) as { error?: string; email?: string };
        return done(r.ok, r.ok ? `Connected${j.email ? ` as ${j.email}` : ""}` : (j.error ?? "Google sign-in failed"));
      }

      if (url.pathname === "/api/auth/apple/web/start" && req.method === "GET") {
        // Sign in with Apple on the PC: the PC opens this in the browser with a one-time session id, then collects the result.
        const session = url.searchParams.get("session") ?? "";
        if (!/^[0-9a-f]{64}$/.test(session)) return page("Sign-in link is broken", "Start again from Pacelife.", 400);
        const u = new URL("https://appleid.apple.com/auth/authorize");
        for (const [k, v] of Object.entries({ client_id: APPLE_WEB_ID, redirect_uri: `${url.origin}/api/auth/apple/web`, response_type: "code id_token", response_mode: "form_post", scope: "email", state: session, nonce: await sha256hex(session) })) u.searchParams.set(k, v);
        return Response.redirect(u.toString(), 302);
      }
      if (url.pathname === "/api/auth/apple/web" && req.method === "POST") {
        const f = await req.formData().catch(() => null);
        const session = String(f?.get("state") ?? "");
        if (!/^[0-9a-f]{64}$/.test(session)) return page("Sign-in didn't finish", "Start again from Pacelife.", 400);
        if (f?.get("error")) return page("Sign-in cancelled", "You can close this tab.", 400);
        let who: Awaited<ReturnType<typeof verifyAppleToken>>;
        try {
          who = await verifyAppleToken(String(f?.get("id_token") ?? ""), session, APPLE_WEB_ID);
        } catch (e) {
          return page("Sign in with Apple didn't work", (e as Error).message, 401);
        }
        const account = await sha256hex("cc-apple:" + who.sub);
        const result = await (await store("acct:" + account).fetch("https://cc/internal/login", { method: "POST", body: JSON.stringify({ account, sub: who.sub }) })).json();
        await store("directory").fetch("https://cc/internal/session/put", { method: "POST", body: JSON.stringify({ session, result }) });
        return page("Signed in", "Go back to Pacelife (the app or the page you started from): it finishes setting up by itself. You can close this tab.");
      }
      if (url.pathname === "/api/auth/session" && req.method === "GET") {
        const session = url.searchParams.get("id") ?? "";
        if (!/^[0-9a-f]{64}$/.test(session)) return err(400, "bad session");
        return store("directory").fetch("https://cc/internal/session/take", { method: "POST", body: JSON.stringify({ session }) });
      }

      if (url.pathname === "/api/link/redeem" && req.method === "POST") {
        // A PC joining an account with a code made on the phone.
        const { h } = (await req.json().catch(() => ({}))) as { h?: string };
        if (!h || !/^[0-9a-f]{64}$/.test(h)) return err(400, "bad code");
        const found = await store("directory").fetch("https://cc/internal/dir/get", { method: "POST", body: JSON.stringify({ h }) });
        if (!found.ok) return new Response(found.body, { status: found.status, headers: { "content-type": "application/json", ...CORS } });
        const { account } = (await found.json()) as { account: string };
        const r = await store("acct:" + account).fetch("https://cc/api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ h }) });
        const j = (await r.json()) as { blob?: string; error?: string };
        return json(r.ok ? { blob: j.blob, account } : j, r.status);
      }

      const account = req.headers.get("x-cc-account");
      if (account != null && !/^[0-9a-f]{64}$/.test(account)) return err(400, "bad account");
      // Accounts are made only by signing in, never claimed.
      if (account && url.pathname === "/api/claim") return err(404, "unknown request");
      return store(account ? "acct:" + account : "main").fetch(req);
    }
    // pacelife.run: the website (what Pacelife is) at the front; the app on the web at /web.
    // The sync service's own address keeps the phone app at "/".
    if (url.pathname === "/" && /(^|\.)pacelife\.run$/.test(url.hostname)) return env.ASSETS.fetch(new Request(new URL("/about", url), req));
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
