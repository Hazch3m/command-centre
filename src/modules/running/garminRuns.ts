import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { PB_DISTANCES } from "./pbs";
import type { FullRun, RunDetail } from "./strava";

/**
 * Runs from Garmin Connect, now that Strava only serves API apps whose owner
 * pays for a subscription. Uses the same Garmin sign-in as the health cards.
 *
 * Garmin runs are stored next to the Strava ones (ids starting "g"), in the
 * same shape, so everything that shows runs works unchanged. Where a run is
 * in both (your history from Strava), the Strava copy is shown.
 *
 * Garmin doesn't give "best efforts" or per-km splits like Strava; they're
 * worked out here from the run's second-by-second data, so PBs, medals,
 * splits and charts look the same as before.
 */

export interface GarminRunSync {
  lastSync: string | null;
  lastError: string | null;
  offline: boolean;
}
export const garminRunState = () => kvGet<GarminRunSync>("garmin.runs.sync", { lastSync: null, lastError: null, offline: false });

/** Garmin activity types that are runs, and the Strava sport name they're stored as. */
const RUN_TYPES: Record<string, string> = {
  running: "Run",
  street_running: "Run",
  track_running: "Run",
  trail_running: "TrailRun",
  treadmill_running: "Treadmill",
  indoor_running: "Treadmill",
  virtual_run: "VirtualRun",
  ultra_run: "TrailRun",
  obstacle_run: "TrailRun",
};
const HISTORY_FROM = "2024-01-01";
const PAGE = 100;
/** Detail requests per sync (two calls each). Garmin publishes no limits, so keep it gentle. */
const DETAIL_BATCH = 8;

interface GarminActivity {
  activityId: number;
  activityName?: string;
  startTimeLocal: string; // "2026-11-03 18:02:11"
  startTimeGMT?: string;
  activityType?: { typeKey?: string };
  eventType?: { typeKey?: string };
  distance?: number;
  duration?: number;
  movingDuration?: number;
  elapsedDuration?: number;
  elevationGain?: number;
  averageHR?: number;
  maxHR?: number;
  calories?: number;
  description?: string | null;
}

interface GarminDetails {
  metricDescriptors?: { metricsIndex: number; key: string }[];
  activityDetailMetrics?: { metrics: (number | null)[] }[];
  geoPolylineDTO?: { polyline?: { lat: number; lon: number }[] } | null;
}
interface GarminSplits {
  lapDTOs?: {
    distance?: number;
    duration?: number;
    movingDuration?: number;
    elapsedDuration?: number;
    averageSpeed?: number;
    averageMovingSpeed?: number;
    averageHR?: number;
    maxHR?: number;
    averageRunCadence?: number;
    elevationGain?: number;
  }[];
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** One Garmin activity as a row of the runs table. */
export function garminRow(a: GarminActivity) {
  const local = a.startTimeLocal.replace(" ", "T").slice(0, 19);
  const gmt = (a.startTimeGMT ?? a.startTimeLocal).replace(" ", "T").slice(0, 19);
  const elapsed = a.elapsedDuration ?? a.duration ?? 0;
  return {
    id: `g${a.activityId}`,
    date: local.slice(0, 10),
    start_local: local,
    start_epoch: Math.floor(Date.parse(gmt + "Z") / 1000),
    name: a.activityName ?? "Run",
    sport: RUN_TYPES[a.activityType?.typeKey ?? ""] ?? "Run",
    distance: a.distance ?? 0,
    moving_time: Math.round(a.movingDuration ?? a.duration ?? elapsed),
    elapsed_time: Math.round(elapsed),
    elevation: a.elevationGain ?? null,
    avg_hr: a.averageHR ?? null,
    max_hr: a.maxHR ?? null,
    workout_type: a.eventType?.typeKey === "race" ? 1 : null,
    has_hr: a.averageHR ? 1 : 0,
  };
}

let syncing: Promise<GarminRunSync> | null = null;
/** New runs from Garmin (the last few days again, in case one was edited), then details for a few runs. */
export function syncGarminRuns(): Promise<GarminRunSync> {
  syncing ??= doSync().finally(() => (syncing = null));
  return syncing;
}

async function doSync(): Promise<GarminRunSync> {
  const status = await backend.garminStatus().catch(() => ({ connected: false }));
  if (!status.connected) return garminRunState();
  let state: GarminRunSync;
  try {
    const [{ latest }] = await db.select<{ latest: string | null }>("SELECT MAX(date) AS latest FROM strava_activities WHERE id LIKE 'g%'");
    const from = latest ? ymd(new Date(Date.parse(latest + "T12:00") - 4 * 86400_000)) : HISTORY_FROM;
    const to = ymd(new Date(Date.now() + 86400_000));
    let added = 0;
    for (let start = 0; start < 5000; start += PAGE) {
      const r = await backend.garminRequest<GarminActivity[]>(`/activitylist-service/activities/search/activities?start=${start}&limit=${PAGE}&startDate=${from}&endDate=${to}`);
      if (r.status === 429) throw new Error("Garmin asked the app to slow down; trying again later.");
      if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`Garmin answered ${r.status} for your activities`);
      const runs = r.body.filter((a) => a && a.activityId && RUN_TYPES[a.activityType?.typeKey ?? ""] && (a.distance ?? 0) > 200);
      if (runs.length)
        await db.batch(
          runs.map((a) => {
            const x = garminRow(a);
            return {
              sql: `INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, synced_at, has_hr)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET name = excluded.name, sport = excluded.sport, distance = excluded.distance,
                      moving_time = excluded.moving_time, elapsed_time = excluded.elapsed_time, elevation = excluded.elevation,
                      avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, workout_type = excluded.workout_type, has_hr = excluded.has_hr,
                      synced_at = CASE WHEN strava_activities.distance <> excluded.distance OR strava_activities.name IS NOT excluded.name THEN excluded.synced_at ELSE strava_activities.synced_at END`,
              params: [x.id, x.date, x.start_local, x.start_epoch, x.name, x.sport, x.distance, x.moving_time, x.elapsed_time, x.elevation, x.avg_hr, x.max_hr, x.workout_type, new Date().toISOString(), x.has_hr],
            };
          }),
        );
      added += runs.length;
      if (r.body.length < PAGE) break;
    }
    if (await syncGarminDetails()) added++;
    state = { lastSync: new Date().toISOString(), lastError: null, offline: false };
    if (added) await notifyChanged("running");
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const prev = await garminRunState();
    state = { ...prev, offline: msg.startsWith("offline"), lastError: msg.startsWith("offline") ? null : msg };
  }
  await kvSet("garmin.runs.sync", state);
  return state;
}

/** Garmin runs that aren't also in your Strava history (those keep Strava's details). */
const NOT_A_DUPLICATE = `NOT EXISTS (SELECT 1 FROM strava_activities s WHERE s.id NOT LIKE 'g%' AND s.id NOT LIKE 'hk%' AND s.start_epoch BETWEEN a.start_epoch - 300 AND a.start_epoch + 300)`;
/** Apple Health runs that aren't also there from Garmin or Strava (Garmin Connect saves runs to Health too). */
const HK_NOT_A_DUPLICATE = `NOT EXISTS (SELECT 1 FROM strava_activities s WHERE s.id NOT LIKE 'hk%' AND s.start_epoch BETWEEN a.start_epoch - 300 AND a.start_epoch + 300)`;
export const SHOWN_RUNS = `((a.id NOT LIKE 'g%' AND a.id NOT LIKE 'hk%') OR (a.id LIKE 'g%' AND ${NOT_A_DUPLICATE}) OR (a.id LIKE 'hk%' AND ${HK_NOT_A_DUPLICATE}))`;

/** Details (splits, best efforts, map, charts) for the newest Garmin runs without them, a few per sync. */
async function syncGarminDetails(): Promise<boolean> {
  const todo = await db.select<{ id: string }>(
    `SELECT a.id FROM strava_activities a LEFT JOIN strava_details d ON d.id = a.id
     WHERE a.id LIKE 'g%' AND ${NOT_A_DUPLICATE}
       AND (d.id IS NULL OR d.fetched_at < a.synced_at)
     ORDER BY a.start_epoch DESC LIMIT ?`,
    [DETAIL_BATCH],
  );
  let any = false;
  for (const { id } of todo) {
    try {
      await fetchGarminRun(id);
      any = true;
    } catch (e) {
      if (/429|slow down/.test(String(e))) break;
      // One run Garmin can't give details for shouldn't stop the rest: remember the try.
      await db.execute("INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", [id, JSON.stringify({ splits: [], bestEfforts: [] }), new Date().toISOString()]);
    }
  }
  return any;
}

/** Fetches one Garmin run's data and stores its details, map and full data. */
export async function fetchGarminRun(id: string): Promise<FullRun> {
  const n = id.replace(/^g/, "");
  if (!/^\d{1,20}$/.test(n)) throw new Error("Not a Garmin activity");
  const [d, s] = await Promise.all([
    backend.garminRequest<GarminDetails>(`/activity-service/activity/${n}/details?maxChartSize=4000&maxPolylineSize=4000`),
    backend.garminRequest<GarminSplits>(`/activity-service/activity/${n}/splits`),
  ]);
  if (d.status === 429 || s.status === 429) throw new Error("429");
  if (d.status !== 200) throw new Error(`Garmin answered ${d.status} for this run`);
  const built = buildFromGarmin(d.body, s.status === 200 ? s.body : null);
  const now = new Date().toISOString();
  await db.batch([
    { sql: "INSERT OR REPLACE INTO strava_details (id, json, fetched_at) VALUES (?, ?, ?)", params: [id, JSON.stringify(built.detail), now] },
    { sql: "INSERT OR REPLACE INTO strava_full (id, json, fetched_at) VALUES (?, ?, ?)", params: [id, JSON.stringify(built.full), now] },
    { sql: "UPDATE strava_activities SET polyline = ? WHERE id = ?", params: [built.polyline, id] },
  ]);
  return built.full;
}

// ---- Turning Garmin's data into Strava's shape ----------------------------------------

export interface Streams {
  time: number[];
  distance: number[];
  heartrate?: number[];
  velocity?: number[];
  altitude?: number[];
  cadence?: number[];
}

/** Garmin's positional samples → named streams (time from the start, distance in m). */
export function garminStreams(d: GarminDetails): Streams | null {
  const idx = new Map((d.metricDescriptors ?? []).map((m) => [m.key, m.metricsIndex]));
  const rows = d.activityDetailMetrics ?? [];
  const col = (...keys: string[]) => {
    const k = keys.find((x) => idx.has(x));
    return k == null ? null : rows.map((r) => r.metrics[idx.get(k)!] ?? null);
  };
  const ts = col("directTimestamp");
  const dur = col("sumElapsedDuration", "sumDuration");
  const dist = col("sumDistance");
  if (!dist || (!ts && !dur)) return null;
  const t0 = ts?.find((x) => x != null) ?? 0;
  const keep: number[] = [];
  rows.forEach((_, i) => dist[i] != null && (ts?.[i] ?? dur?.[i]) != null && keep.push(i));
  const time = keep.map((i) => (ts ? (ts[i]! - t0) / 1000 : dur![i]!));
  const fill = (xs: (number | null)[] | null) => {
    if (!xs || !xs.some((x) => x != null)) return undefined;
    let last = xs.find((x) => x != null) ?? 0;
    return keep.map((i) => (xs[i] != null ? (last = xs[i]!) : last));
  };
  const half = col("directRunCadence");
  const double = col("directDoubleCadence");
  return {
    time,
    distance: keep.map((i) => dist[i]!),
    heartrate: fill(col("directHeartRate")),
    velocity: fill(col("directSpeed", "directGradeAdjustedSpeed")),
    altitude: fill(col("directElevation")),
    cadence: fill(half ?? (double ? double.map((x) => (x == null ? null : x / 2)) : null)),
  };
}

/** Fastest time over each standard distance inside a run (like Strava's best efforts). */
export function bestEfforts(st: Pick<Streams, "time" | "distance">): RunDetail["bestEfforts"] {
  const { time, distance } = st;
  const total = distance[distance.length - 1] ?? 0;
  const out: RunDetail["bestEfforts"] = [];
  for (const pb of PB_DISTANCES) {
    if (pb.m > total + 1) break;
    let best = Infinity;
    let j = 0;
    for (let i = 0; i < distance.length; i++) {
      // Earliest start j such that distance[i] - distance[j] still covers the distance.
      while (j < i && distance[i] - distance[j + 1] >= pb.m) j++;
      const covered = distance[i] - distance[j];
      if (covered < pb.m) continue;
      // Trim the overshoot at the start, assuming even pace within the sample.
      const span = time[i] - time[j];
      const t = span - (covered > pb.m && j + 1 <= i ? ((covered - pb.m) / Math.max(1e-6, distance[j + 1] - distance[j])) * (time[j + 1] - time[j]) : 0);
      if (t > 0 && t < best) best = t;
    }
    if (isFinite(best)) out.push({ name: pb.name, time: Math.round(best) });
  }
  return out;
}

/** Per-km splits from the streams: time, pace, heart rate and climb for each full kilometre (and the bit left over). */
export function kmSplits(st: Streams): RunDetail["splits"] {
  const out: RunDetail["splits"] = [];
  const { time, distance } = st;
  let startI = 0;
  const at = (i: number) => ({ t: time[i], d: distance[i] });
  const close = (endI: number) => {
    const a = at(startI);
    const b = at(endI);
    const dd = b.d - a.d;
    const dt = b.t - a.t;
    if (dd < 50 || dt <= 0) return;
    const hrs = st.heartrate?.slice(startI, endI + 1) ?? [];
    out.push({
      distance: dd,
      moving_time: Math.round(dt),
      speed: dd / dt,
      gap: null,
      hr: hrs.length ? hrs.reduce((s, x) => s + x, 0) / hrs.length : null,
      elev: st.altitude ? st.altitude[endI] - st.altitude[startI] : null,
    });
  };
  for (let i = 1; i < distance.length; i++) {
    if (distance[i] - distance[startI] >= 1000) {
      close(i);
      startI = i;
    }
  }
  if (startI < distance.length - 1) close(distance.length - 1);
  return out;
}

/** Google's encoded polyline (what the map draws), from Garmin's list of points. */
export function encodePolyline(points: { lat: number; lon: number }[]): string {
  let out = "";
  let pl = 0;
  let pn = 0;
  const enc = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) {
      out += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    out += String.fromCharCode(x + 63);
  };
  for (const p of points) {
    if (p.lat == null || p.lon == null) continue;
    const la = Math.round(p.lat * 1e5);
    const lo = Math.round(p.lon * 1e5);
    enc(la - pl);
    enc(lo - pn);
    pl = la;
    pn = lo;
  }
  return out;
}

/** Thins a stream to at most n points for the charts. */
function thin<T>(xs: T[] | undefined, step: number): T[] | undefined {
  return xs ? xs.filter((_, i) => i % step === 0 || i === xs.length - 1) : undefined;
}

export function buildFromGarmin(d: GarminDetails, s: GarminSplits | null): { detail: RunDetail; full: FullRun; polyline: string | null } {
  const st = garminStreams(d);
  const laps = (s?.lapDTOs ?? [])
    .filter((l) => (l.distance ?? 0) > 0)
    .map((l, i) => {
      const moving = l.movingDuration ?? l.duration ?? l.elapsedDuration ?? 0;
      return {
        name: `Lap ${i + 1}`,
        distance: l.distance ?? 0,
        moving_time: Math.round(moving),
        elapsed_time: Math.round(l.elapsedDuration ?? l.duration ?? moving),
        speed: l.averageMovingSpeed ?? l.averageSpeed ?? (moving ? (l.distance ?? 0) / moving : 0),
        hr: l.averageHR ?? null,
        max_hr: l.maxHR ?? null,
        cadence: l.averageRunCadence ?? null,
        elev: l.elevationGain ?? null,
      };
    });
  const splits = st ? kmSplits(st) : [];
  const detail: RunDetail = {
    splits,
    bestEfforts: st ? bestEfforts(st) : [],
    laps: laps.map((l) => ({ distance: l.distance, moving_time: l.moving_time, speed: l.speed, hr: l.hr })),
  };
  const step = st ? Math.max(1, Math.ceil(st.distance.length / 1500)) : 1;
  const full: FullRun = {
    laps,
    splits,
    streams: st
      ? {
          distance: thin(st.distance, step),
          time: thin(st.time, step),
          heartrate: thin(st.heartrate, step),
          velocity: thin(st.velocity, step),
          altitude: thin(st.altitude, step),
          cadence: thin(st.cadence, step),
        }
      : null,
    description: null,
    calories: null,
    device: null,
  };
  const pts = d.geoPolylineDTO?.polyline ?? [];
  return { detail, full, polyline: pts.length > 1 ? encodePolyline(pts) : null };
}
