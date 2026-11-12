import { db } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { hkDetailsAsGarmin } from "../health/appleHealth";
import { buildFromGarmin } from "./garminRuns";
import type { Statement } from "../../core/backend.types";
import { isRunType, parseActivitiesCsv, parseActivityFile, zipEntries, zipRead, type ArchiveActivity, type Track } from "./archiveFiles";

/**
 * Your Strava archive, brought in once: every run in it, with its route, splits and charts. It's your
 * own copy of your data (downloaded by you from Strava's website), so it's kept like any other run.
 *
 * Runs are stored next to the others with ids "sx" + Strava's activity id. A run that's also here from
 * Strava's connection or Garmin shows once (theirs); one that's here from Apple Health shows once (this).
 */

export const sxId = (stravaId: string) => "sx" + stravaId;

export interface ImportProgress {
  stage: "reading" | "runs" | "done";
  done: number;
  total: number;
}
export interface ImportResult {
  runs: number;
  withRoute: number;
  skipped: number;
  first: string | null;
  last: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Local wall-clock time of a UTC instant, at a given offset (minutes east), as "YYYY-MM-DDTHH:MM:SS". */
export function localAt(ms: number, offsetMin: number) {
  const d = new Date(ms + offsetMin * 60_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** The run's row, from the CSV line (and its file's time zone and heart rate when the CSV lacks them). */
export function archiveRow(a: ArchiveActivity, t: Track | null) {
  // The CSV's times are UTC. A FIT file says the time zone it was recorded in; otherwise this device's.
  const off = t?.tzOffsetMin ?? -new Date(a.start).getTimezoneOffset();
  const local = localAt(a.start, off);
  const hrs = t?.hr.map((h) => h[1]) ?? [];
  const avgHr = a.avgHr ?? (hrs.length ? hrs.reduce((x, y) => x + y, 0) / hrs.length : null);
  const maxHr = a.maxHr ?? (hrs.length ? Math.max(...hrs) : null);
  return {
    id: sxId(a.id),
    date: local.slice(0, 10),
    start_local: local,
    start_epoch: Math.floor(a.start / 1000),
    name: a.name,
    sport: /virtual|treadmill/i.test(a.type) ? "Treadmill" : /trail/i.test(a.type) ? "TrailRun" : "Run",
    distance: Math.round(a.distance * 10) / 10,
    moving_time: Math.round(a.moving || a.elapsed),
    elapsed_time: Math.round(a.elapsed || a.moving),
    elevation: a.elevation,
    avg_hr: avgHr ? Math.round(avgHr) : null,
    max_hr: maxHr ? Math.round(maxHr) : null,
    has_hr: avgHr ? 1 : 0,
  };
}

/** Reads the archive and stores its runs. Runs already imported are updated, not doubled. */
export async function importStravaArchive(file: Blob, onProgress?: (p: ImportProgress) => void): Promise<ImportResult> {
  onProgress?.({ stage: "reading", done: 0, total: 0 });
  const entries = await zipEntries(file);
  const csvEntry = entries.find((e) => /(^|\/)activities\.csv$/i.test(e.name));
  if (!csvEntry) throw new Error("There's no activities.csv in this zip. Choose the export_….zip file Strava emailed you (not a single activity).");
  const csv = new TextDecoder().decode(await zipRead(file, csvEntry));
  const all = parseActivitiesCsv(csv);
  const runs = all.filter((a) => isRunType(a.type) && a.distance > 200);
  const byName = new Map(entries.map((e) => [e.name.replace(/^.*?(activities\/)/i, "$1").toLowerCase(), e]));
  let withRoute = 0;
  const now = new Date().toISOString();
  const BATCH = 10;
  for (let i = 0; i < runs.length; i += BATCH) {
    const stmts: Statement[] = [];
    for (const a of runs.slice(i, i + BATCH)) {
      let t: Track | null = null;
      const e = a.file ? byName.get(a.file.toLowerCase()) : undefined;
      if (e) {
        try {
          t = await parseActivityFile(e.name, await zipRead(file, e));
        } catch {
          t = null; // a damaged or unknown file: the run still comes in, without its route
        }
      }
      const x = archiveRow(a, t);
      stmts.push({
        sql: `INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, synced_at, has_hr)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, distance = excluded.distance, moving_time = excluded.moving_time, elapsed_time = excluded.elapsed_time,
                elevation = excluded.elevation, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, has_hr = excluded.has_hr`,
        params: [x.id, x.date, x.start_local, x.start_epoch, x.name, x.sport, x.distance, x.moving_time, x.elapsed_time, x.elevation, x.avg_hr, x.max_hr, now, x.has_hr],
      });
      if (t && (t.route.length > 1 || t.dist.length > 1)) {
        const built = buildFromGarmin(hkDetailsAsGarmin(t), null);
        if (t.route.length > 1) withRoute++;
        stmts.push(
          { sql: "INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", params: [x.id, JSON.stringify(built.detail), now] },
          { sql: "INSERT OR REPLACE INTO strava_full (id, json, fetched_at) VALUES (?, ?, ?)", params: [x.id, JSON.stringify(built.full), now] },
          { sql: "UPDATE strava_activities SET polyline = ? WHERE id = ?", params: [built.polyline, x.id] },
        );
      } else {
        // No samples: mark it looked at, so nothing tries to fetch it from anywhere.
        stmts.push({ sql: "INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", params: [x.id, JSON.stringify({ splits: [], bestEfforts: [] }), now] });
      }
    }
    await db.batch(stmts);
    onProgress?.({ stage: "runs", done: Math.min(runs.length, i + BATCH), total: runs.length });
  }
  if (runs.length) await notifyChanged("running");
  const dates = runs.map((a) => a.start).sort((x, y) => x - y);
  onProgress?.({ stage: "done", done: runs.length, total: runs.length });
  return {
    runs: runs.length,
    withRoute,
    skipped: all.length - runs.length,
    first: dates.length ? new Date(dates[0]).toISOString().slice(0, 10) : null,
    last: dates.length ? new Date(dates[dates.length - 1]).toISOString().slice(0, 10) : null,
  };
}
