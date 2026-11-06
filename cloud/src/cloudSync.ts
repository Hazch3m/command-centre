/**
 * One cloud sync: open the latest copy of your data, fetch what's new from
 * Garmin and your calendars (with the app's own code), record the changes for
 * the PC and the phone, and save a fresh copy for the phone.
 */
import type { SqlJsStatic } from "sql.js";
import { cloudMayWrite, gunzip, gzip, linkKeys, packSnapshot, PHONE_FILES, phoneMayWrite, seal, unpackSnapshot, unseal, type CloudOp, type PhoneOp, type SnapshotHeader } from "../../src/core/sync";
import { setContext, type Creds } from "./appBackend";
import { syncGarminRuns } from "../../src/modules/running/garminRuns";
import { syncHealth } from "../../src/modules/health/data";
import { syncCalendar } from "../../src/modules/calendar/data";
import { runAutoSync } from "../../src/modules/watch/autoSync";

export interface CloudIO {
  /** The latest sealed snapshot and its version, or null. */
  loadSnapshot(): Promise<{ box: Uint8Array; version: number; applied: number } | null>;
  /** Saves a new snapshot unless a newer one arrived meanwhile. */
  saveSnapshot(box: Uint8Array, applied: number, cloudApplied: number, ifVersion: number): Promise<boolean>;
  cloudOpsAfter(id: number): { id: number; body: Uint8Array }[];
  /** Changes made on the phone after this id (applied here too, so nothing waits for a PC). */
  phoneOpsAfter?(id: number): { id: number; body: Uint8Array }[];
  addCloudOp(body: Uint8Array): number;
  creds: Creds;
  saveCreds(c: Creds): Promise<void>;
  /** An account's own store (no PC owns the data): what it's connected to is what the cloud holds. */
  account?: boolean;
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

export async function runCloudSync(io: CloudIO, only?: ("runs" | "health" | "calendar" | "watch")[]): Promise<SyncResult & { applied?: number }> {
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
    // Changes made on the phone that this copy doesn't have yet (the PC, if there is one, applies them too).
    let header2: SnapshotHeader = header;
    let phoneApplied = header.applied;
    for (const row of io.phoneOpsAfter?.(header.applied) ?? []) {
      try {
        const op = JSON.parse(new TextDecoder().decode(await unseal(keys.key, row.body))) as PhoneOp;
        for (const st of op.stmts ?? []) {
          if (!phoneMayWrite(st.sql, st.params)) continue;
          try {
            db.run(st.sql, st.params);
          } catch {
            /* changed meanwhile */
          }
        }
        if (op.file && PHONE_FILES.has(op.file.name) && typeof op.file.contents === "string") {
          JSON.parse(op.file.contents);
          header2 = { ...header2, files: { ...header2.files, [op.file.name]: op.file.contents } };
        }
      } catch {
        /* a change that can't be read or applied is skipped */
      }
      phoneApplied = row.id;
    }
    // What the cloud itself is connected to (an account's Garmin was signed in to on the phone).
    const connected = io.account
      ? { ...header2.connected, garmin: !!io.creds.garmin, google: !!io.creds.google || header2.connected.google }
      : { ...header2.connected, garmin: !!io.creds.garmin || header2.connected.garmin, google: !!io.creds.google || header2.connected.google };
    const headerChanged = phoneApplied !== header.applied || !header.cloud || connected.garmin !== header.connected.garmin || connected.google !== header.connected.google;
    header2 = { ...header2, connected, cloud: true };
    const runCount = () => Number(db.exec("SELECT count(*) FROM strava_activities")[0]?.values[0][0] ?? 0);
    const before = runCount();
    const writes: CloudOp["stmts"] = [];
    const ctx = { db, writes, files: header2.files, creds: io.creds, saveCreds: async (c: Creds) => ((io.creds = c), await io.saveCreds(c)) };
    setContext(ctx);
    const errors: SyncResult["errors"] = {};
    const want = (k: "runs" | "health" | "calendar" | "watch") => !only || only.includes(k);
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
      // Watch sync: keep the plan's next days on the Garmin calendar (the cloud does it while cloud sync is on).
      if (io.creds.garmin && want("watch")) {
        const on = (db.exec("SELECT value FROM kv WHERE key = 'watch.autosync.settings'")[0]?.values[0][0] as string | undefined) ?? "";
        if (/"on":\s*true/.test(on)) {
          const s = await runAutoSync().catch((e) => ({ lastError: String((e as Error)?.message ?? e) }));
          errors.watch = s.lastError ?? null;
        }
      }
    } finally {
      setContext(null);
    }
    const kept = writes.filter((w) => cloudMayWrite(w.sql, w.params));
    const newRuns = Math.max(0, runCount() - before);
    if (!kept.length && !headerChanged) return { ranAt, wrote: 0, errors, newRuns };
    if (kept.length) {
      const id = io.addCloudOp(await seal(keys.key, new TextEncoder().encode(JSON.stringify({ at: ranAt, stmts: kept } satisfies CloudOp))));
      lastOp = Math.max(lastOp, id);
    }
    // The phone has no use for second-by-second run data; it stays with the PC.
    db.run("DELETE FROM strava_full");
    const next: SnapshotHeader & { cloudApplied: number; cloudMade: string } = { ...header2, applied: phoneApplied, cloudApplied: lastOp, cloudMade: ranAt };
    const box = await seal(keys.key, await gzip(packSnapshot(next, db.export())));
    await io.saveSnapshot(box, phoneApplied, lastOp, snap.version);
    return { ranAt, wrote: kept.length, errors, newRuns, applied: phoneApplied };
  } finally {
    db.close();
  }
}
