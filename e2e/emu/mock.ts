import { DatabaseSync } from "node:sqlite";
const conv = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
export class SqlStorage {
  constructor(public db: DatabaseSync) {}
  exec<T = any>(q: string, ...b: unknown[]) {
    let rows: any[] = [];
    if (!b.length && q.trim().replace(/;\s*$/, "").includes(";")) this.db.exec(q);
    else {
      const st = this.db.prepare(q);
      if (/^\s*(SELECT|WITH)|\bRETURNING\b/i.test(q)) rows = st.all(...(b.map(conv) as any[])).map((r: any) => { for (const k in r) if (r[k] instanceof Uint8Array) r[k] = r[k].buffer.slice(r[k].byteOffset, r[k].byteOffset + r[k].byteLength); return r; });
      else st.run(...(b.map(conv) as any[]));
    }
    return { toArray: () => rows as T[], one: () => { if (rows.length !== 1) throw new Error("expected one row"); return rows[0] as T; } };
  }
}
export class DurableObject<E = unknown> { ctx: any; env: E; constructor(ctx: any, env: E) { this.ctx = ctx; this.env = env; } }
export function makeCtx(file: string, onAlarm: (at: number | null) => void) {
  const db = new DatabaseSync(file);
  const sql = new SqlStorage(db);
  let alarm: number | null = null;
  return {
    waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error("waitUntil", e)),
    storage: {
      sql,
      transactionSync(fn: () => void) { db.exec("BEGIN"); try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } },
      setAlarm: async (t: number) => { alarm = t; onAlarm(t); },
      getAlarm: async () => alarm,
      deleteAlarm: async () => { alarm = null; onAlarm(null); },
    },
  };
}
