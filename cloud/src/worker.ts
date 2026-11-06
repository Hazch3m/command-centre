/**
 * Command Centre sync service (Cloudflare Worker + one SQLite Durable Object).
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
 */
import { DurableObject } from "cloudflare:workers";
import { garminGet, type Creds } from "./appBackend";
import { runCloudSync, type SyncResult } from "./cloudSync";
import initSqlJs, { type SqlJsStatic } from "sql.js/dist/sql-wasm.js";
import wasmModule from "sql.js/dist/sql-wasm.wasm";

let SQL: Promise<SqlJsStatic> | null = null;
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
}

const CHUNK = 1_500_000; // under the 2 MB per-value limit
const MAX_SNAPSHOT = 60_000_000;
const MAX_OP = 2_000_000;
const PAIR_TTL = 15 * 60_000;
const PAIR_FAILS = 10; // wrong codes allowed per 15 minutes

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "content-type, x-cc-token",
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

  /** One cloud sync (one at a time). Calendars at most hourly: they're rewritten in full each time. */
  private runSync(force = false): Promise<SyncResult> {
    this.syncing ??= (async () => {
      const creds = this.creds();
      if (!creds) return { ranAt: new Date().toISOString(), wrote: 0, errors: { cloud: "Cloud sync is off." }, newRuns: 0 };
      const calAt = Number(this.get("cloudCalAt") ?? 0);
      const withCal = force || Date.now() - calAt > 55 * 60_000;
      const io = {
        creds,
        sqlJs,
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
        r = await runCloudSync(io, withCal ? undefined : ["runs", "health", "watch"]);
        if (withCal) this.set("cloudCalAt", String(Date.now()));
      } catch (e) {
        r = { ranAt: new Date().toISOString(), wrote: 0, errors: { cloud: String((e as Error)?.message ?? e) }, newRuns: 0 };
      }
      this.set("cloudLast", JSON.stringify(r));
      // Old changes everyone has: the PC applied them and the phone's copy includes them.
      const pcAck = Number(this.get("cloudAck") ?? 0);
      const inSnap = Number(this.get("snapCloud") ?? 0);
      this.sql.exec("DELETE FROM cloudops WHERE id <= ? AND at < ?", Math.min(pcAck, inSnap), Date.now() - 86400_000);
      return r;
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  async alarm() {
    if (!this.creds()) return;
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

    // ---- No token needed --------------------------------------------------------
    if (path === "/health") return json({ ok: true, claimed: !!this.get("tokenHash") });

    if (path === "/claim" && m === "POST") {
      // Set the access token the first time; afterwards only the same token (or a rotation, below) works.
      const { token } = (await req.json()) as { token?: string };
      if (!token || !/^[0-9a-f]{64}$/.test(token)) return err(400, "bad token");
      const h = await sha256hex(token);
      const have = this.get("tokenHash");
      if (have && have !== h) return err(409, "This sync service is already linked to another Command Centre.");
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

    if (!(await this.authed(req))) return err(401, "Not linked. Pair this device from Command Centre on your PC.");

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
    if (path === "/release" && m === "POST") {
      // "Disconnect" on the PC: free the service so a PC can connect afresh.
      await this.wipe();
      return json({ ok: true });
    }

    if (path === "/cloud/enable" && m === "POST") {
      const c = (await req.json()) as Creds;
      if (!c?.secret || typeof c.secret !== "string") return err(400, "bad credentials");
      this.set("creds", JSON.stringify({ secret: c.secret, garmin: c.garmin ?? null, google: c.google ?? null, ics: Array.isArray(c.ics) ? c.ics : [] }));
      this.set("cloudCalAt", "0");
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return json({ ok: true });
    }
    if (path === "/cloud/disable" && m === "POST") {
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
      return json({ expires: Date.now() + PAIR_TTL });
    }

    if (path === "/rotate" && m === "POST") {
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      const stub = env.STORE.get(env.STORE.idFromName("main"));
      return stub.fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
