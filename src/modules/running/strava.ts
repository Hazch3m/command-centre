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
];

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
  workout_type?: number | null;
}

/**
 * Fetches new and recently edited activities and caches them. The first sync
 * backfills from 2024; after that only the last few days are re-read.
 */
export async function syncStrava(): Promise<SyncState> {
  const status = await backend.oauthStatus("strava").catch(() => null);
  if (!status?.connected) return syncState();
  const [{ latest }] = await db.select<{ latest: number | null }>("SELECT MAX(start_epoch) AS latest FROM strava_activities");
  const after = latest ? latest - 3 * 86400 : HISTORY_FROM;
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
            sql: `INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, synced_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET name = excluded.name, sport = excluded.sport, distance = excluded.distance,
                    moving_time = excluded.moving_time, elapsed_time = excluded.elapsed_time, elevation = excluded.elevation,
                    avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, workout_type = excluded.workout_type, synced_at = excluded.synced_at`,
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
            ],
          })),
        );
      added += runs.length;
      if (r.body.length < 200) break;
    }
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
    `SELECT id, date, start_local, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type
     FROM strava_activities WHERE date >= ? ORDER BY start_local`,
    [fromDate],
  );
}
