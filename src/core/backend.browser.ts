/**
 * Development harness only (`npm run preview:browser`): runs the real SQL in the
 * browser with sql.js so the UI can be tested without the desktop shell.
 * Never included in the installed app.
 */
import initSqlJs, { type Database } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { Backend, BackupStatus, ExecResult, SqlParam } from "./backend.types";

const STORAGE_KEY = "cc-browser-db";
const channel = new BroadcastChannel("cc-events");
let dbPromise: Promise<Database> | null = null;
let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

function load(bytes?: Uint8Array): Database {
  const saved = bytes ? null : localStorage.getItem(STORAGE_KEY);
  const db = bytes
    ? new SQL!.Database(bytes)
    : saved
      ? new SQL!.Database(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0)))
      : new SQL!.Database();
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  return db;
}

function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = initSqlJs({ locateFile: () => wasmUrl }).then((s) => {
      SQL = s;
      return load();
    });
  }
  return dbPromise;
}

function persist(db: Database) {
  const bytes = db.export();
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  localStorage.setItem(STORAGE_KEY, btoa(bin));
}

const norm = (p: SqlParam[]) => p.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v));

function run(db: Database, sql: string, params: SqlParam[]): ExecResult {
  if (params.length === 0 && sql.trim().replace(/;$/, "").includes(";")) db.exec(sql);
  else db.run(sql, norm(params));
  const changes = db.getRowsModified();
  const id = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] as number;
  return { changes, lastInsertId: id ?? 0 };
}

// One channel handler per tab: reload our copy of the database once, then fan
// the event out locally. (Reloading per listener raced and dropped refreshes.)
channel.addEventListener("message", async (e: MessageEvent) => {
  if (!e.data?.event) return;
  if (dbPromise) {
    const old = await dbPromise;
    // localStorage reaches other tabs asynchronously, so the sender ships its database with the event.
    dbPromise = Promise.resolve(load(e.data.db));
    old.close();
  }
  window.dispatchEvent(new CustomEvent("cc:" + e.data.event, { detail: e.data.payload }));
});

let fullscreen = false;
const backups: string[] = [];

export const backend: Backend = {
  kind: "browser",
  async select<T>(sql: string, params: SqlParam[] = []) {
    const db = await getDb();
    const stmt = db.prepare(sql);
    stmt.bind(norm(params));
    const out: T[] = [];
    while (stmt.step()) out.push(stmt.getAsObject() as T);
    stmt.free();
    return out;
  },
  async execute(sql, params = []) {
    const db = await getDb();
    const r = run(db, sql, params);
    persist(db);
    return r;
  },
  async batch(statements) {
    const db = await getDb();
    db.exec("BEGIN");
    try {
      const out = statements.map((s) => run(db, s.sql, s.params ?? []));
      db.exec("COMMIT");
      persist(db);
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
  async emit(event, payload) {
    channel.postMessage({ event, payload, db: dbPromise ? (await dbPromise).export() : undefined });
    window.dispatchEvent(new CustomEvent("cc:" + event, { detail: payload }));
  },
  async listen(event, cb) {
    const local = (e: Event) => cb((e as CustomEvent).detail);
    window.addEventListener("cc:" + event, local);
    return () => window.removeEventListener("cc:" + event, local);
  },
  getConfig: async () => ({ monitor: null, quickAddShortcut: "Ctrl+Alt+Space", fullscreen }),
  listMonitors: async () => [
    { name: "Browser window", x: 0, y: 0, width: screen.width, height: screen.height, scale: devicePixelRatio, primary: true, current: true, chosen: true },
  ],
  setMonitor: async () => {},
  setFullscreen: async (on) => {
    fullscreen = on;
  },
  setQuickAddShortcut: async () => {},
  hideQuickAdd: async () => {},
  autostartEnabled: async () => false,
  setAutostart: async () => {},
  backupStatus: async (): Promise<BackupStatus> => ({ folder: "(browser preview)", latest: backups.at(-1) ?? null, count: backups.length }),
  backupNow: async () => {
    backups.push(new Date().toISOString().slice(0, 10));
    return { folder: "(browser preview)", latest: backups.at(-1)!, count: backups.length };
  },
  dataFolder: async () => "(browser preview — data kept in localStorage)",
  openDataFolder: async () => {},
  appVersion: async () => "dev",

  readDataFile: async (name) => localStorage.getItem("cc-file:" + name),
  writeDataFile: async (name, contents) => localStorage.setItem("cc-file:" + name, contents),
  // Test harness: services are "connected" when a fixture file exists next to the page.
  oauthStatus: async (p) => {
    const ok = !!(await fixture(p));
    return { configured: ok, connected: ok, account: ok ? `${p} (test data)` : null };
  },
  oauthSetClient: async () => {},
  oauthConnect: async (p) => backend.oauthStatus(p),
  oauthDisconnect: async () => {},
  apiRequest: async <T,>(p: "strava" | "google", method: string, url: string, body?: unknown) => {
    const fx = await fixture(p);
    if (!fx) throw new Error("offline: no test data for " + p);
    return fakeApi(fx, method, url, body) as { status: number; body: T };
  },
};

// ---- Fake APIs for UI tests (fixtures/<provider>.json, not shipped) ----------
const fixtures = new Map<string, Promise<any>>();
function fixture(p: string): Promise<any> {
  if (!fixtures.has(p)) fixtures.set(p, fetch(`fixtures/${p}.json`).then((r) => (r.ok ? r.json() : null), () => null));
  return fixtures.get(p)!;
}
function fakeApi(fx: any, method: string, url: string, body: unknown): { status: number; body: unknown } {
  const u = new URL(url);
  if (u.pathname === "/api/v3/athlete/activities") {
    const after = Number(u.searchParams.get("after") ?? 0);
    const before = Number(u.searchParams.get("before") ?? Infinity);
    const page = Number(u.searchParams.get("page") ?? 1);
    const per = Number(u.searchParams.get("per_page") ?? 30);
    const all = (fx.activities as any[])
      .filter((a) => Date.parse(a.start_date) / 1000 > after && Date.parse(a.start_date) / 1000 < before)
      .sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
    return { status: 200, body: all.slice((page - 1) * per, page * per) };
  }
  const handler = fx.routes?.[`${method} ${u.pathname}`];
  return handler !== undefined ? { status: 200, body: handler } : { status: 404, body: { error: "not in fixture", method, path: u.pathname, body } };
}
