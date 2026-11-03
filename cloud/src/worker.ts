/**
 * Command Centre sync service (Cloudflare Worker + one SQLite Durable Object).
 *
 * Holds three things, all encrypted by the PC or phone before they arrive:
 *  - the PC's latest snapshot (the dashboard's database), in chunks
 *  - changes made on the phone, waiting for the PC to apply them
 *  - a short-lived pairing entry while a phone is being linked
 * Access needs the token derived from the link's secret; only its hash is kept.
 * The first PC to "claim" the service sets that hash.
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
  STORE: DurableObjectNamespace<Store>;
  ASSETS: Fetcher;
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
      const version = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM snap");
        for (let i = 0, n = 0; i < body.length; i += CHUNK, n++) this.sql.exec("INSERT INTO snap (i, data) VALUES (?, ?)", n, body.slice(i, i + CHUNK).buffer);
        this.set("snapVersion", String(version));
        this.set("snapApplied", String(applied));
        this.set("snapSize", String(body.length));
      });
      return json({ version });
    }

    if (path === "/snapshot" && m === "GET") {
      const parts = this.sql.exec<{ data: ArrayBuffer }>("SELECT data FROM snap ORDER BY i").toArray();
      if (!parts.length) return err(404, "Nothing synced from the PC yet.");
      const total = parts.reduce((a, p) => a + p.data.byteLength, 0);
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        out.set(new Uint8Array(p.data), o);
        o += p.data.byteLength;
      }
      return new Response(out, {
        headers: { "content-type": "application/octet-stream", "x-cc-version": this.get("snapVersion") ?? "0", "x-cc-applied": this.get("snapApplied") ?? "0", "cache-control": "no-store", ...CORS },
      });
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
      });
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
