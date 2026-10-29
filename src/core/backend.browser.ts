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

function load(): Database {
  const saved = localStorage.getItem(STORAGE_KEY);
  const db = saved ? new SQL!.Database(Uint8Array.from(atob(saved), (c) => c.charCodeAt(0))) : new SQL!.Database();
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
    channel.postMessage({ event, payload });
    window.dispatchEvent(new CustomEvent("cc:" + event, { detail: payload }));
  },
  async listen(event, cb) {
    const local = (e: Event) => cb((e as CustomEvent).detail);
    const remote = async (e: MessageEvent) => {
      if (e.data?.event !== event) return;
      // Another tab wrote to its copy; reload ours from storage before notifying.
      const db = await getDb();
      db.close();
      dbPromise = Promise.resolve(load());
      cb(e.data.payload);
    };
    window.addEventListener("cc:" + event, local);
    channel.addEventListener("message", remote);
    return () => {
      window.removeEventListener("cc:" + event, local);
      channel.removeEventListener("message", remote);
    };
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
};
