/**
 * One cloud sync: open the latest copy of your data, fetch what's new from
 * Garmin and your calendars (with the app's own code), record the changes for
 * the PC and the phone, and save a fresh copy for the phone.
 */
import type { SqlJsStatic } from "sql.js";
import { cloudMayWrite, gunzip, gzip, linkKeys, packSnapshot, seal, unpackSnapshot, unseal, type CloudOp, type SnapshotHeader } from "../../src/core/sync";
import { setContext, type Creds } from "./appBackend";
import { syncGarminRuns } from "../../src/modules/running/garminRuns";
import { syncHealth } from "../../src/modules/health/data";
import { syncCalendar } from "../../src/modules/calendar/data";

export interface CloudIO {
  /** The latest sealed snapshot and its version, or null. */
  loadSnapshot(): Promise<{ box: Uint8Array; version: number; applied: number } | null>;
  /** Saves a new snapshot unless a newer one arrived meanwhile. */
  saveSnapshot(box: Uint8Array, applied: number, cloudApplied: number, ifVersion: number): Promise<boolean>;
  cloudOpsAfter(id: number): { id: number; body: Uint8Array }[];
  addCloudOp(body: Uint8Array): number;
  creds: Creds;
  saveCreds(c: Creds): Promise<void>;
  /** SQLite (sql.js), loaded the way the place running this needs. */
  sqlJs(): Promise<SqlJsStatic>;
}


export interface SyncResult {
  ranAt: string;
  wrote: number;
  /** Per source: an error, or null if it went fine. */
  errors: Record<string, string | null>;
  newRuns: number;
}

export async function runCloudSync(io: CloudIO, only?: ("runs" | "health" | "calendar")[]): Promise<SyncResult> {
  const ranAt = new Date().toISOString();
  const snap = await io.loadSnapshot();
  if (!snap) return { ranAt, wrote: 0, errors: { data: "No copy from the PC yet: open Command Centre on the PC once." }, newRuns: 0 };
  const keys = await linkKeys(io.creds.secret);
  const { header, db: bytes } = unpackSnapshot(await gunzip(await unseal(keys.key, snap.box)));
  const S = await io.sqlJs();
  const db = new S.Database(bytes);
  try {
    // Changes the cloud made earlier that the PC's latest copy doesn't have yet.
    const done = (header as SnapshotHeader & { cloudApplied?: number }).cloudApplied ?? 0;
    let lastOp = done;
    for (const row of io.cloudOpsAfter(done)) {
      const op = JSON.parse(new TextDecoder().decode(await unseal(keys.key, row.body))) as CloudOp;
      for (const s of op.stmts) {
        if (!cloudMayWrite(s.sql, s.params)) continue;
        try {
          db.run(s.sql, s.params);
        } catch {
          /* a row the PC changed meanwhile: the PC's version wins */
        }
      }
      lastOp = row.id;
    }
    const runCount = () => Number(db.exec("SELECT count(*) FROM strava_activities")[0]?.values[0][0] ?? 0);
    const before = runCount();
    const writes: CloudOp["stmts"] = [];
    const ctx = { db, writes, creds: io.creds, saveCreds: async (c: Creds) => ((io.creds = c), await io.saveCreds(c)) };
    setContext(ctx);
    const errors: SyncResult["errors"] = {};
    const want = (k: "runs" | "health" | "calendar") => !only || only.includes(k);
    try {
      if (io.creds.garmin && want("runs")) {
        const s = await syncGarminRuns().catch((e) => ({ lastError: String((e as Error)?.message ?? e) }));
        errors.runs = s.lastError ?? null;
      }
      if (io.creds.garmin && want("health")) {
        const s = await syncHealth().catch((e) => ({ errors: [String((e as Error)?.message ?? e)] }));
        errors.health = s.errors?.length ? s.errors.join("; ") : null;
      }
      if ((io.creds.google || io.creds.ics.length) && want("calendar")) {
        const s = await syncCalendar().catch((e) => ({ error: String((e as Error)?.message ?? e) }));
        errors.calendar = s.error ?? null;
      }
    } finally {
      setContext(null);
    }
    const kept = writes.filter((w) => cloudMayWrite(w.sql, w.params));
    const newRuns = Math.max(0, runCount() - before);
    if (!kept.length) return { ranAt, wrote: 0, errors, newRuns };
    const id = io.addCloudOp(await seal(keys.key, new TextEncoder().encode(JSON.stringify({ at: ranAt, stmts: kept } satisfies CloudOp))));
    lastOp = Math.max(lastOp, id);
    // The phone has no use for second-by-second run data; it stays with the PC.
    db.run("DELETE FROM strava_full");
    const next: SnapshotHeader & { cloudApplied: number; cloudMade: string } = { ...header, cloudApplied: lastOp, cloudMade: ranAt };
    const box = await seal(keys.key, await gzip(packSnapshot(next, db.export())));
    await io.saveSnapshot(box, header.applied, lastOp, snap.version);
    return { ranAt, wrote: kept.length, errors, newRuns };
  } finally {
    db.close();
  }
}
