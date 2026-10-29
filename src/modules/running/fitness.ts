import { useEffect, useState } from "react";
import { backend } from "@backend";
import { useDataVersion } from "../../core/events";
import { addDays, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { mondayOf, type Plan } from "./plan";
import { km, parseTime, raceHistory } from "./stats";
import { loadDetails, loadReadings, loadRuns, loadShoes, type Run, type RunDetail, type Shoe } from "./strava";
import {
  estimateRun,
  garminOffset,
  judge,
  loadRatio,
  predictTime,
  projectionAt,
  slopePerWeek,
  trimp,
  vdot,
  weeklySeries,
  type RunEstimate,
  type TrendStatus,
  type Vo2Config,
  type WeekPoint,
} from "./vo2";

export const FITNESS_FILE = "fitness.json";

export interface FitnessConfig extends Vo2Config {
  /** Apply the Garmin calibration offset when readings exist. */
  calibrate: boolean;
}

/** Defaults from the coach's log: max HR 199, threshold ~186–189; goals sub-2:50 then sub-2:45. */
export const DEFAULT_FITNESS: FitnessConfig = {
  hrMax: 199,
  hrRest: 50,
  calibrate: true,
  projection: {
    start: { date: "2026-11-09", vo2: null },
    milestones: [
      { date: "2027-05-30", vo2: Math.round(vdot(42195, 170 * 60) * 10) / 10, label: "Sub-2:50 · Edinburgh" },
      { date: "2027-12-05", vo2: Math.round(vdot(42195, 165 * 60) * 10) / 10, label: "Sub-2:45 · Valencia" },
    ],
  },
};

export async function loadFitnessConfig(): Promise<FitnessConfig> {
  const text = await backend.readDataFile(FITNESS_FILE);
  if (text == null) {
    await backend.writeDataFile(FITNESS_FILE, JSON.stringify(DEFAULT_FITNESS, null, 2));
    return DEFAULT_FITNESS;
  }
  try {
    const c = JSON.parse(text) as Partial<FitnessConfig>;
    return { ...DEFAULT_FITNESS, ...c, projection: { ...DEFAULT_FITNESS.projection, ...(c.projection ?? {}) } };
  } catch {
    return DEFAULT_FITNESS;
  }
}

export async function saveFitnessConfig(c: FitnessConfig) {
  await backend.writeDataFile(FITNESS_FILE, JSON.stringify(c, null, 2));
}

/**
 * The slower end of a target like "17:15–17:30" or "2:48–2:52", in seconds.
 * Two-part times are h:mm for a half or longer, m:ss otherwise.
 */
export function targetTime(text: string, distance: number): number | null {
  const last = text.split(/[–-]/).pop()!.trim();
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(last);
  if (!m) return null;
  if (m[3]) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return distance >= 21000 ? +m[1] * 3600 + +m[2] * 60 : parseTime(m[0]);
}

/** Detail splits → estimator input, preferring Strava's grade-adjusted speed. */
export function splitsFor(d: RunDetail) {
  return d.splits.map((s) => ({ distance: s.distance, moving_time: s.moving_time, speed: s.gap ?? s.speed, hr: s.hr }));
}

export interface Fitness {
  config: FitnessConfig;
  offset: number;
  estimates: RunEstimate[]; // calibrated, oldest first
  weekly: WeekPoint[];
  readings: { date: string; vo2: number }[];
  races: { date: string; name: string; vdot: number }[];
  start: { date: string; vo2: number } | null;
  project: (date: string) => number | null;
  current: number | null; // smoothed, calibrated
  thisWeek: { status: TrendStatus; value: number | null; projected: number | null; week: string };
  slope: number | null; // per week, last 8 weeks
  neededSlope: number | null; // per week, to the next milestone
  nextMilestone: { date: string; vo2: number; label: string } | null;
  predictions: { name: string; distance: number; seconds: number | null; target: string | null; targetSeconds: number | null }[];
  load: ReturnType<typeof loadRatio>;
  loadSeries: { date: string; acute: number; chronic: number }[];
  efficiency: { week: string; value: number | null }[];
  shoes: (Shoe & { limit: number; racing: boolean })[];
  latest: (Run & { detail: RunDetail | null; estimate: RunEstimate | null; shoe: Shoe | null }) | null;
}

const RACING = /alphafly|vaporfly|metaspeed|adios pro|endorphin pro|elite|rocket x|sc elite|supercomp elite/i;

export function computeFitness(
  runs: Run[],
  details: Map<string, RunDetail>,
  readings: { date: string; vo2: number }[],
  shoes: Shoe[],
  config: FitnessConfig,
  plan: Plan | undefined,
  today: string,
): Fitness {
  // Raw estimates first, then calibrate to Garmin if there are readings.
  const raw: RunEstimate[] = [];
  for (const r of runs) {
    const d = details.get(r.id);
    if (!d) continue;
    const e = estimateRun(splitsFor(d), config);
    if (e) raw.push({ id: r.id, date: r.date, name: r.name, vo2: e.vo2, n: e.n });
  }
  const offset = config.calibrate && readings.length ? garminOffset(readings, raw) ?? 0 : 0;
  const estimates = raw.map((e) => ({ ...e, vo2: e.vo2 + offset }));

  const thisMonday = mondayOf(today);
  const weekly = weeklySeries(estimates, addDays(thisMonday, -51 * 7), thisMonday);
  const current = [...weekly].reverse().find((w) => w.smooth != null)?.smooth ?? null;

  // Projection start: the fixed value, else the smoothed estimate around the start date.
  const ps = config.projection.start;
  let startVo2 = ps.vo2;
  if (startVo2 == null) {
    const around = estimates.filter((e) => e.date > addDays(ps.date, -42) && e.date <= addDays(ps.date, 7)).map((e) => e.vo2);
    const pool = around.length >= 2 ? around : estimates.slice(-6).map((e) => e.vo2);
    if (pool.length) startVo2 = [...pool].sort((a, b) => a - b)[pool.length >> 1];
  }
  const start = startVo2 != null ? { date: ps.date, vo2: startVo2 } : null;
  const project = (date: string) => (start ? projectionAt(date, start, config.projection.milestones) : null);

  const lastWithValue = [...weekly].reverse().find((w) => w.value != null && w.week >= addDays(thisMonday, -7));
  const wk = lastWithValue ?? weekly[weekly.length - 1];
  const projected = project(addDays(wk.week, 3));
  const thisWeek = {
    week: wk.week,
    value: wk.value,
    projected,
    status: projected == null ? ("no-data" as TrendStatus) : judge(wk.value, projected),
  };

  const nextMilestone = config.projection.milestones.filter((m) => m.date > today).sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;
  const neededSlope =
    nextMilestone && current != null ? (nextMilestone.vo2 - current) / Math.max(1, (Date.parse(nextMilestone.date) - Date.parse(today)) / (7 * 86400000)) : null;

  const races = plan ? raceHistory(runs, plan).map((r) => ({ date: r.date, name: r.name, vdot: vdot(r.km * 1000, r.time) })) : [];

  const DIST = [
    { name: "5k", distance: 5000, match: /5k/i },
    { name: "10k", distance: 10000, match: /10k/i },
    { name: "Half", distance: 21097.5, match: /half/i },
    { name: "Marathon", distance: 42195, match: /marathon/i },
  ];
  const predictions = DIST.map((d) => {
    const race = plan?.races.find((r) => d.match.test(r.name) && r.date && r.date >= today);
    const targetSeconds = race ? targetTime(race.target, d.distance) : null;
    return { name: d.name, distance: d.distance, seconds: current != null ? predictTime(d.distance, current) : null, target: race ? `${race.name}: ${race.target}` : null, targetSeconds };
  });

  // Training load, per day.
  const daily = new Map<string, number>();
  for (const r of runs) daily.set(r.date, (daily.get(r.date) ?? 0) + trimp(r.moving_time, r.avg_hr, config));
  const dailyArr = [...daily.entries()].map(([date, load]) => ({ date, load }));
  const load = loadRatio(dailyArr, today);
  const loadSeries: Fitness["loadSeries"] = [];
  for (let d = addDays(today, -83); d <= today; d = addDays(d, 1)) {
    const l = loadRatio(dailyArr, d);
    loadSeries.push({ date: d, acute: l.acute, chronic: l.chronic });
  }

  // Aerobic efficiency on easy runs: metres per heartbeat.
  const easy = runs.filter((r) => r.avg_hr && r.avg_hr < 0.78 * config.hrMax && r.distance >= 6000 && r.moving_time > 0);
  const efficiency = weekly.map((w) => {
    const xs = easy.filter((r) => mondayOf(r.date) === w.week).map((r) => (r.distance / r.moving_time) * 60 / r.avg_hr!);
    return { week: w.week, value: xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null };
  });

  const shoeList = shoes
    .filter((s) => !s.retired)
    .map((s) => ({ ...s, racing: RACING.test(s.name), limit: RACING.test(s.name) ? 500 : 800 }))
    .sort((a, b) => b.km / b.limit - a.km / a.limit);

  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const latest = lastRun
    ? {
        ...lastRun,
        detail: details.get(lastRun.id) ?? null,
        estimate: estimates.find((e) => e.id === lastRun.id) ?? null,
        shoe: shoes.find((s) => s.id === lastRun.gear_id) ?? null,
      }
    : null;

  return {
    config,
    offset,
    estimates,
    weekly,
    readings,
    races,
    start,
    project,
    current,
    thisWeek,
    slope: slopePerWeek(weekly),
    neededSlope,
    nextMilestone,
    predictions,
    load,
    loadSeries,
    efficiency,
    shoes: shoeList,
    latest,
  };
}

/** Everything the fitness views need, recomputed when runs or settings change. */
export function useFitness(plan: Plan | undefined): Fitness | undefined {
  const today = useToday();
  const version = useDataVersion("running");
  const [cfgTick, setCfgTick] = useState(0);
  useEffect(() => {
    const f = () => setCfgTick((t) => t + 1);
    window.addEventListener("cc:fitness-config", f);
    return () => window.removeEventListener("cc:fitness-config", f);
  }, []);
  const from = addDays(today, -430);
  const { data } = useQuery(
    () => Promise.all([loadRuns("2024-01-01"), loadDetails(from), loadReadings(), loadShoes(), loadFitnessConfig()]),
    [version, today, cfgTick],
  );
  if (!data) return undefined;
  const [runs, details, readings, shoes, config] = data;
  return computeFitness(runs, details, readings, shoes, config, plan, today);
}

export function fitnessConfigChanged() {
  window.dispatchEvent(new Event("cc:fitness-config"));
}

export const fmtVo2 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));
export { km };
