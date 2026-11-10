import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { isNativeApp, native } from "../../core/native";
import { buildFromGarmin } from "../running/garminRuns";

/**
 * Apple Health, read on the iPhone: runs from any watch or app that saves to Health (Apple Watch,
 * COROS, Polar, Suunto, Strava, Nike Run Club, the Fitness app…), with heart rate and route, plus
 * resting heart rate, HRV, sleep and VO2 max.
 *
 * Runs are stored next to the Garmin and Strava ones (ids starting "hk"), in the same shape, so
 * everything that shows runs works unchanged. A run that's also there from Garmin or Strava (Garmin
 * Connect saves to Health too) shows once: theirs. Daily health values only fill days Garmin hasn't.
 */
export const APPLE_HEALTH_KEY = "apple.health";
export interface AppleHealthState {
  on: boolean;
  lastSync: string | null;
  lastError: string | null;
}
export const appleHealthState = () => kvGet<AppleHealthState>(APPLE_HEALTH_KEY, { on: false, lastSync: null, lastError: null });

interface HkWorkout {
  uuid: string;
  start: number;
  end: number;
  duration: number;
  distance: number;
  source?: string;
  indoor?: boolean;
  elevation?: number;
  avgHr?: number;
  maxHr?: number;
}
interface HkDetail {
  hr: number[][];
  dist: number[][];
  route: number[][];
}
interface HkDay {
  date: string;
  rhr?: number;
  hrv?: number;
  vo2?: number;
  sleep?: number;
}
type HealthNative = {
  healthAvailable(o?: object): Promise<{ available: boolean }>;
  healthAuthorize(o?: object): Promise<{ ok: boolean }>;
  healthWorkouts(o: { since: number; limit?: number }): Promise<{ workouts: HkWorkout[] }>;
  healthWorkoutDetail(o: { uuid: string }): Promise<HkDetail>;
  healthDaily(o: { since: number }): Promise<{ days: HkDay[] }>;
};
const hk = () => native() as unknown as HealthNative;

/** Apple Health can be connected here (inside the iPhone app, on a device with Health). */
export async function appleHealthAvailable(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    return (await hk().healthAvailable({})).available;
  } catch {
    return false;
  }
}

/** Asks for read access (Apple's own sheet), then brings in your runs and health. */
export async function connectAppleHealth(): Promise<AppleHealthState> {
  await hk().healthAuthorize({});
  await kvSet(APPLE_HEALTH_KEY, { on: true, lastSync: null, lastError: null } satisfies AppleHealthState);
  await notifyChanged("health");
  return syncAppleHealth(true);
}

/** Stops reading Apple Health (what's already here stays; Health's own settings revoke access). */
export async function disconnectAppleHealth() {
  const s = await appleHealthState();
  await kvSet(APPLE_HEALTH_KEY, { ...s, on: false });
  await notifyChanged("health");
}

const HISTORY_FROM = Date.parse("2024-01-01T00:00:00");
const DETAIL_BATCH = 10;
const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const nameFor = (ms: number, indoor: boolean) => {
  const h = new Date(ms).getHours();
  const when = h < 5 ? "Night" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : h < 21 ? "Evening" : "Night";
  return indoor ? `${when} Treadmill Run` : `${when} Run`;
};
export const hkId = (uuid: string) => "hk" + uuid.replace(/-/g, "").toLowerCase();

/** One Apple Health workout as a row of the runs table. */
export function hkRow(w: HkWorkout) {
  const local = localIso(w.start);
  return {
    id: hkId(w.uuid),
    date: local.slice(0, 10),
    start_local: local,
    start_epoch: Math.floor(w.start / 1000),
    name: nameFor(w.start, !!w.indoor),
    sport: w.indoor ? "Treadmill" : "Run",
    distance: w.distance || 0,
    moving_time: Math.round(w.duration || (w.end - w.start) / 1000),
    elapsed_time: Math.round((w.end - w.start) / 1000),
    elevation: w.elevation ?? null,
    avg_hr: w.avgHr ? Math.round(w.avgHr) : null,
    max_hr: w.maxHr ? Math.round(w.maxHr) : null,
    has_hr: w.avgHr ? 1 : 0,
  };
}

const R = 6371000;
const rad = (x: number) => (x * Math.PI) / 180;
const metres = (a: number[], b: number[]) => {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[2] - a[2]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * A run's samples in the shape Garmin's details come in, so the same code makes its splits, best
 * efforts, charts and map: the route (GPS) when there is one, else the distance samples (treadmill).
 */
export function hkDetailsAsGarmin(d: HkDetail) {
  const hrAt = (() => {
    let j = 0;
    return (t: number) => {
      if (!d.hr.length) return null;
      while (j + 1 < d.hr.length && Math.abs(d.hr[j + 1][0] - t) <= Math.abs(d.hr[j][0] - t)) j++;
      return Math.abs(d.hr[j][0] - t) < 30_000 ? d.hr[j][1] : null;
    };
  })();
  const rows: (number | null)[][] = [];
  let polyline: { lat: number; lon: number }[] = [];
  if (d.route.length > 1) {
    let sum = 0;
    d.route.forEach((p, i) => {
      if (i) {
        const step = metres(d.route[i - 1], p);
        if (step < 200) sum += step; // a GPS jump isn't distance run
      }
      rows.push([p[0], sum, hrAt(p[0]), p[3] ?? null, p[4] != null && p[4] >= 0 ? p[4] : null]);
    });
    const every = Math.max(1, Math.ceil(d.route.length / 3000));
    polyline = d.route.filter((_, i) => i % every === 0 || i === d.route.length - 1).map((p) => ({ lat: p[1], lon: p[2] }));
  } else if (d.dist.length) {
    let sum = 0;
    for (const [t, m] of d.dist) {
      sum += m;
      rows.push([t, sum, hrAt(t), null, null]);
    }
  }
  return {
    metricDescriptors: [
      { metricsIndex: 0, key: "directTimestamp" },
      { metricsIndex: 1, key: "sumDistance" },
      { metricsIndex: 2, key: "directHeartRate" },
      { metricsIndex: 3, key: "directElevation" },
      { metricsIndex: 4, key: "directSpeed" },
    ],
    activityDetailMetrics: rows.map((metrics) => ({ metrics })),
    geoPolylineDTO: polyline.length > 1 ? { polyline } : null,
  };
}

const uuidOf = (id: string) => id.replace(/^hk(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5").toUpperCase();

/** One Apple Health run's splits, map and charts, read from Health and stored. */
export async function fetchHkRun(id: string, uuid = uuidOf(id)) {
  if (!isNativeApp()) throw new Error("This run came from Apple Health: open it on your iPhone to load its details.");
  const built = buildFromGarmin(hkDetailsAsGarmin(await hk().healthWorkoutDetail({ uuid })), null);
  const now = new Date().toISOString();
  await db.batch([
    { sql: "INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", params: [id, JSON.stringify(built.detail), now] },
    { sql: "INSERT OR REPLACE INTO strava_full (id, json, fetched_at) VALUES (?, ?, ?)", params: [id, JSON.stringify(built.full), now] },
    { sql: "UPDATE strava_activities SET polyline = ? WHERE id = ?", params: [built.polyline, id] },
  ]);
  return built.full;
}

let syncing: Promise<AppleHealthState> | null = null;
/** New runs and days from Apple Health (the last few days again, in case one was edited). Quiet if it's off. */
export function syncAppleHealth(force = false): Promise<AppleHealthState> {
  syncing ??= doSync(force).finally(() => (syncing = null));
  return syncing;
}

async function doSync(force: boolean): Promise<AppleHealthState> {
  const prev = await appleHealthState();
  if (!prev.on || !isNativeApp()) return prev;
  // Not more often than every ten minutes unless asked.
  if (!force && prev.lastSync && Date.now() - Date.parse(prev.lastSync) < 10 * 60_000) return prev;
  let state: AppleHealthState;
  try {
    const [{ latest }] = await db.select<{ latest: number | null }>("SELECT MAX(start_epoch) AS latest FROM strava_activities WHERE id LIKE 'hk%'");
    const since = latest ? (latest - 4 * 86400) * 1000 : HISTORY_FROM;
    const { workouts } = await hk().healthWorkouts({ since, limit: 600 });
    const runs = workouts.filter((w) => w && w.uuid && (w.distance ?? 0) > 200);
    if (runs.length)
      await db.batch(
        runs.map((w) => {
          const x = hkRow(w);
          return {
            sql: `INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, synced_at, has_hr)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET distance = excluded.distance, moving_time = excluded.moving_time, elapsed_time = excluded.elapsed_time,
                    elevation = excluded.elevation, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, has_hr = excluded.has_hr`,
            params: [x.id, x.date, x.start_local, x.start_epoch, x.name, x.sport, x.distance, x.moving_time, x.elapsed_time, x.elevation, x.avg_hr, x.max_hr, new Date().toISOString(), x.has_hr],
          };
        }),
      );
    // Splits, map and charts for the newest runs without them.
    const todo = await db.select<{ id: string }>(
      `SELECT a.id FROM strava_activities a LEFT JOIN strava_details d ON d.id = a.id WHERE a.id LIKE 'hk%' AND d.id IS NULL ORDER BY a.start_epoch DESC LIMIT ?`,
      [DETAIL_BATCH],
    );
    const byId = new Map(workouts.map((w) => [hkId(w.uuid), w.uuid]));
    for (const { id } of todo) {
      try {
        await fetchHkRun(id, byId.get(id) ?? uuidOf(id));
      } catch {
        await db.execute("INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", [id, JSON.stringify({ splits: [], bestEfforts: [] }), new Date().toISOString()]);
      }
    }
    // Daily health: fills days Garmin hasn't (Garmin's values win where both exist).
    const { days } = await hk().healthDaily({ since: Date.now() - (prev.lastSync ? 10 : 60) * 86400_000 });
    const rows = days.filter((d) => d.rhr || d.hrv || d.vo2 || d.sleep);
    if (rows.length)
      await db.batch(
        rows.map((d) => ({
          sql: `INSERT INTO health_daily (date, rhr, hrv, vo2, sleep_secs, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(date) DO UPDATE SET rhr = COALESCE(health_daily.rhr, excluded.rhr), hrv = COALESCE(health_daily.hrv, excluded.hrv),
                  vo2 = COALESCE(health_daily.vo2, excluded.vo2), sleep_secs = COALESCE(health_daily.sleep_secs, excluded.sleep_secs)`,
          params: [d.date, d.rhr ? Math.round(d.rhr) : null, d.hrv ? Math.round(d.hrv) : null, d.vo2 ? Math.round(d.vo2 * 10) / 10 : null, d.sleep ? Math.round(d.sleep) : null, new Date().toISOString()],
        })),
      );
    state = { on: true, lastSync: new Date().toISOString(), lastError: null };
    if (runs.length || todo.length) await notifyChanged("running");
    if (rows.length) await notifyChanged("health");
  } catch (e) {
    state = { ...prev, lastError: String((e as Error)?.message ?? e) };
  }
  await kvSet(APPLE_HEALTH_KEY, state);
  return state;
}
