import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";

/** One run as cached locally (Strava's numbers, SI units). */
export interface Run {
  id: string;
  date: string; // local YYYY-MM-DD
  start_local: string;
  name: string;
  sport: string;
  distance: number; // m
  moving_time: number; // s
  elapsed_time: number; // s
  elevation: number; // m
  avg_hr: number | null;
  max_hr: number | null;
  workout_type: number | null; // 1 = race
  polyline: string | null;
  gear_id: string | null;
}

export interface RunDetail {
  splits: { distance: number; moving_time: number; speed: number; gap: number | null; hr: number | null; elev: number | null }[];
  bestEfforts: { name: string; time: number }[];
  /** Watch laps (auto-lap or workout steps), when fetched. */
  laps?: { distance: number; moving_time: number; speed: number; hr: number | null }[];
}

export const migrations = [
  `CREATE TABLE strava_activities (
     id TEXT PRIMARY KEY,
     date TEXT NOT NULL,
     start_local TEXT NOT NULL,
     start_epoch INTEGER NOT NULL,
     name TEXT,
     sport TEXT NOT NULL,
     distance REAL NOT NULL,
     moving_time INTEGER NOT NULL,
     elapsed_time INTEGER NOT NULL,
     elevation REAL,
     avg_hr REAL,
     max_hr REAL,
     workout_type INTEGER,
     synced_at TEXT NOT NULL
   );
   CREATE INDEX strava_date ON strava_activities(date);`,
  // 1 — maps, shoes and per-run detail (1 km splits with heart rate) for VO2 max
  `ALTER TABLE strava_activities ADD COLUMN polyline TEXT;
   ALTER TABLE strava_activities ADD COLUMN gear_id TEXT;
   ALTER TABLE strava_activities ADD COLUMN has_hr INTEGER;
   CREATE TABLE strava_details (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     fetched_at TEXT NOT NULL
   );
   CREATE TABLE vo2_readings (
     date TEXT PRIMARY KEY,
     vo2 REAL NOT NULL,
     source TEXT NOT NULL DEFAULT 'garmin'
   );`,
  // 2 — your own changes to the plan, one per day (the doc stays the master copy)
  `CREATE TABLE plan_overrides (
     date TEXT PRIMARY KEY,
     text TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
];

/** Your edits to the plan, by date. */
export async function loadOverrides(): Promise<Map<string, string>> {
  const rows = await db.select<{ date: string; text: string }>("SELECT date, text FROM plan_overrides");
  return new Map(rows.map((r) => [r.date, r.text]));
}

export async function setOverride(date: string, text: string | null) {
  if (text == null) await db.execute("DELETE FROM plan_overrides WHERE date = ?", [date]);
  else await db.execute("INSERT OR REPLACE INTO plan_overrides (date, text, updated_at) VALUES (?, ?, ?)", [date, text.trim() || "Rest", new Date().toISOString()]);
  await notifyChanged("running");
}

const RUN_SPORTS = ["Run", "TrailRun", "VirtualRun", "Treadmill"];
const HISTORY_FROM = Date.UTC(2024, 0, 1) / 1000; // the progression page goes back to 2024
const TOPIC = "running";

export interface SyncState {
  lastSync: string | null;
  lastError: string | null;
  offline: boolean;
}

export function syncState() {
  return kvGet<SyncState>("strava.sync", { lastSync: null, lastError: null, offline: false });
}

interface StravaActivity {
  id: number;
  name: string;
  sport_type: string;
  type: string;
  start_date: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  max_heartrate?: number;
  has_heartrate?: boolean;
  workout_type?: number | null;
  gear_id?: string | null;
  map?: { summary_polyline?: string | null };
}

/** Strava's detailed activity, the parts we keep. */
interface StravaDetail {
  splits_metric?: { distance: number; moving_time: number; average_speed: number; average_grade_adjusted_speed?: number; average_heartrate?: number; elevation_difference?: number }[];
  best_efforts?: { name: string; elapsed_time: number }[];
  laps?: { distance: number; moving_time: number; average_speed: number; average_heartrate?: number }[];
}

/** Detail requests per sync. Strava allows 100 requests per 15 minutes; this leaves plenty of headroom. */
const DETAIL_BATCH = 25;

/**
 * Fetches new and recently edited activities and caches them. The first sync
 * backfills from 2024; after that only the last few days are re-read.
 */
let syncing: Promise<SyncState> | null = null;

/** One sync at a time, shared by every card that asks. */
export function syncStrava(): Promise<SyncState> {
  syncing ??= doSyncStrava().finally(() => (syncing = null));
  return syncing;
}

async function doSyncStrava(): Promise<SyncState> {
  const status = await backend.oauthStatus("strava").catch(() => null);
  if (!status?.connected) return syncState();
  const [{ latest }] = await db.select<{ latest: number | null }>("SELECT MAX(start_epoch) AS latest FROM strava_activities");
  // Runs synced before maps and shoes were stored: re-read once to fill them in.
  const [{ old }] = await db.select<{ old: number }>("SELECT count(*) AS old FROM strava_activities WHERE has_hr IS NULL");
  const after = latest && !old ? latest - 3 * 86400 : HISTORY_FROM;
  let state: SyncState;
  try {
    let added = 0;
    for (let page = 1; page < 50; page++) {
      const r = await backend.apiRequest<StravaActivity[]>(
        "strava",
        "GET",
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
      );
      if (r.status === 429) throw new Error("Strava's rate limit was hit; trying again later.");
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`Strava answered ${r.status}`);
      const runs = r.body.filter((a) => RUN_SPORTS.includes(a.sport_type ?? a.type));
      if (runs.length)
        await db.batch(
          runs.map((a) => ({
            sql: `INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, synced_at, polyline, gear_id, has_hr)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET name = excluded.name, sport = excluded.sport, distance = excluded.distance,
                    moving_time = excluded.moving_time, elapsed_time = excluded.elapsed_time, elevation = excluded.elevation,
                    avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, workout_type = excluded.workout_type, synced_at = excluded.synced_at,
                    polyline = excluded.polyline, gear_id = excluded.gear_id, has_hr = excluded.has_hr`,
            params: [
              String(a.id),
              a.start_date_local.slice(0, 10),
              a.start_date_local.slice(0, 19),
              Math.floor(Date.parse(a.start_date) / 1000),
              a.name,
              a.sport_type ?? a.type,
              a.distance,
              a.moving_time,
              a.elapsed_time,
              a.total_elevation_gain ?? null,
              a.average_heartrate ?? null,
              a.max_heartrate ?? null,
              a.workout_type ?? null,
              new Date().toISOString(),
              a.map?.summary_polyline ?? null,
              a.gear_id ?? null,
              a.has_heartrate || a.average_heartrate ? 1 : 0,
            ],
          })),
        );
      added += runs.length;
      if (r.body.length < 200) break;
    }
    // Anything the full refresh didn't see (deleted on Strava) shouldn't trigger it again.
    if (old) await db.execute("UPDATE strava_activities SET has_hr = 0 WHERE has_hr IS NULL");
    if (await syncDetails()) added++;
    await syncShoes();
    state = { lastSync: new Date().toISOString(), lastError: null, offline: false };
    if (added) await notifyChanged(TOPIC);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const prev = await syncState();
    state = { ...prev, offline: msg.startsWith("offline"), lastError: msg.startsWith("offline") ? null : msg };
  }
  await kvSet("strava.sync", state);
  await notifyChanged(TOPIC);
  return state;
}

export function loadRuns(fromDate: string) {
  return db.select<Run>(
    `SELECT id, date, start_local, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, polyline, gear_id
     FROM strava_activities WHERE date >= ? ORDER BY start_local`,
    [fromDate],
  );
}

/**
 * Fetches 1 km splits for runs with heart rate that don't have them yet:
 * the newest run first (and again if it was edited), then a gentle backfill
 * of the last ~14 months, a batch per sync.
 */
async function syncDetails(): Promise<boolean> {
  const todo = await db.select<{ id: string }>(
    `SELECT a.id FROM strava_activities a LEFT JOIN strava_details d ON d.id = a.id
     WHERE a.has_hr = 1 AND a.date >= date('now', '-430 days')
       AND (d.id IS NULL OR (d.fetched_at < a.synced_at AND a.date >= date('now', '-2 days'))
            -- laps (for pace on point) arrived later: fetch recent runs again once
            OR (d.json NOT LIKE '%"laps"%' AND a.date >= date('now', '-60 days')))
     ORDER BY a.start_epoch DESC LIMIT ?`,
    [DETAIL_BATCH],
  );
  let any = false;
  for (const { id } of todo) {
    const r = await backend.apiRequest<StravaDetail>("strava", "GET", `https://www.strava.com/api/v3/activities/${id}?include_all_efforts=false`);
    if (r.status === 429) break; // rate limited: carry on next sync
    if (r.status === 404) {
      await db.execute("UPDATE strava_activities SET has_hr = 0 WHERE id = ?", [id]);
      continue;
    }
    if (r.status !== 200) throw new Error(`Strava answered ${r.status}`);
    const detail: RunDetail = {
      splits: (r.body.splits_metric ?? []).map((s) => ({
        distance: s.distance,
        moving_time: s.moving_time,
        speed: s.average_speed,
        gap: s.average_grade_adjusted_speed ?? null,
        hr: s.average_heartrate ?? null,
        elev: s.elevation_difference ?? null,
      })),
      bestEfforts: (r.body.best_efforts ?? []).map((b) => ({ name: b.name, time: b.elapsed_time })),
      laps: (r.body.laps ?? []).map((l) => ({ distance: l.distance, moving_time: l.moving_time, speed: l.average_speed, hr: l.average_heartrate ?? null })),
    };
    await db.execute("INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", [id, JSON.stringify(detail), new Date().toISOString()]);
    any = true;
  }
  return any;
}

export interface Shoe {
  id: string;
  name: string;
  km: number;
  primary: boolean;
  retired: boolean;
}

async function syncShoes() {
  const r = await backend.apiRequest<{ shoes?: { id: string; name: string; distance: number; primary: boolean; retired?: boolean }[] }>(
    "strava",
    "GET",
    "https://www.strava.com/api/v3/athlete",
  );
  if (r.status !== 200) return;
  const shoes: Shoe[] = (r.body.shoes ?? []).map((s) => ({ id: s.id, name: s.name, km: s.distance / 1000, primary: s.primary, retired: !!s.retired }));
  await kvSet("strava.shoes", shoes);
}

export const loadShoes = () => kvGet<Shoe[]>("strava.shoes", []);

export async function loadDetails(fromDate: string): Promise<Map<string, RunDetail>> {
  const rows = await db.select<{ id: string; json: string }>(
    "SELECT d.id, d.json FROM strava_details d JOIN strava_activities a ON a.id = d.id WHERE a.date >= ?",
    [fromDate],
  );
  const out = new Map<string, RunDetail>();
  for (const r of rows) {
    try {
      out.set(r.id, JSON.parse(r.json));
    } catch {
      /* skip a damaged row */
    }
  }
  return out;
}

// ---- Garmin VO2 max readings (typed in from the watch) ------------------------

export const loadReadings = () => db.select<{ date: string; vo2: number }>("SELECT date, vo2 FROM vo2_readings ORDER BY date");

export async function addReading(date: string, vo2: number) {
  if (!(vo2 > 20 && vo2 < 95)) throw new Error("Enter the VO2 max your watch shows, e.g. 57.");
  await db.execute("INSERT OR REPLACE INTO vo2_readings (date, vo2) VALUES (?, ?)", [date, vo2]);
  await notifyChanged(TOPIC);
}

export async function deleteReading(date: string) {
  await db.execute("DELETE FROM vo2_readings WHERE date = ?", [date]);
  await notifyChanged(TOPIC);
}
