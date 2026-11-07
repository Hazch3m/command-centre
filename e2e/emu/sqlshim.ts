// sql.js's API on top of node:sqlite (enough for the sync service's code).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
let n = 0;
class Stmt {
  private rows: Record<string, unknown>[] = []; private i = -1; private params: unknown[] = [];
  constructor(private st: ReturnType<DatabaseSync["prepare"]>) {}
  bind(p: unknown[]) { this.params = p ?? []; return true; }
  step() { if (this.i < 0) this.rows = this.st.all(...(this.params as never[])) as Record<string, unknown>[]; this.i++; return this.i < this.rows.length; }
  getAsObject() { return this.rows[this.i]; }
  free() {}
}
class Database {
  db: DatabaseSync; file: string; changes = 0;
  constructor(bytes?: Uint8Array) {
    this.file = path.join(os.tmpdir(), `sqlshim-${process.pid}-${n++}.db`);
    if (bytes?.length) fs.writeFileSync(this.file, bytes); else if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
    this.db = new DatabaseSync(this.file);
  }
  run(sql: string, params: unknown[] = []) { const r = this.db.prepare(sql).run(...(params.map((v) => (v instanceof Uint8Array ? v : v)) as never[])); this.changes = Number(r.changes); return this; }
  exec(sql: string) {
    const s = sql.trim();
    if (/^select/i.test(s) && !s.replace(/;\s*$/, "").includes(";")) {
      const st = this.db.prepare(s); const rows = st.all() as Record<string, unknown>[];
      if (!rows.length) return [];
      const columns = Object.keys(rows[0]);
      return [{ columns, values: rows.map((r) => columns.map((c) => r[c])) }];
    }
    this.db.exec(sql); return [];
  }
  prepare(sql: string) { return new Stmt(this.db.prepare(sql)); }
  getRowsModified() { return this.changes; }
  export() { this.db.close(); const b = new Uint8Array(fs.readFileSync(this.file)); this.db = new DatabaseSync(this.file); return b; }
  close() { try { this.db.close(); } catch {} try { fs.unlinkSync(this.file); } catch {} }
}
export default async function initSqlJs() { return { Database }; }
