import { useEffect, useState } from "react";
import { backend } from "@backend";
import { useDataVersion } from "../../core/events";
import { addDays, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { mondayOf, type Plan } from "./plan";
import { latestPredictions } from "../health/data";
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
  /** Put estimates on your race-result (VDOT) scale, the scale the goals and predictions use. */
  calibrate: boolean;
  /** Show VO2 max numbers on Garmin's scale (needs a Garmin reading) or the race scale. Display only. */
  displayScale?: "race" | "garmin";
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
  calibration: "races" | "none";
  /** Garmin's VO2 max runs on its own scale: how far above the race scale your readings sit. */
  garmin: { offset: number; latest: { date: string; vo2: number }; equivalent: number | null } | null;
  /** Added to VO2 max numbers when they're shown (Garmin scale), 0 on the race scale. */
  shift: number;
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
  predictions: {
    name: string;
    distance: number;
    seconds: number | null;
    formSeconds: number | null;
    /** Equal-endurance (Daniels VDOT) prediction from the best recent level. */
    vdotSeconds: number | null;
    /** VDOT prediction slowed down when the marathon shape is short of what this distance needs. */
    shapeSeconds: number | null;
    /** Garmin's own prediction, when synced. */
    garminSeconds: number | null;
    /** Garmin's prediction about a month earlier. */
    garminMonthAgo: number | null;
    /** This prediction as it stood 30 days ago. */
    monthAgoSeconds: number | null;
    target: string | null;
    targetSeconds: number | null;
  }[];
  /** Your speed–endurance curve: time ∝ distance^k, anchored on your best recent 10k-equivalent. */
  endurance: { k: number; ten: number; anchor: string; fitted: boolean; used: string[] } | null;
  garminPredictionsDate: string | null;
  /** Runalyze-style marathon shape: is the training volume there for long races? */
  shape: MarathonShape | null;
  /** VDOT the predictions use: the better of current form and the best race in the last year. */
  predictionBasis: { vdot: number; source: "form" | "race"; race?: { name: string; date: string; vdot: number } } | null;
  load: ReturnType<typeof loadRatio>;
  loadSeries: { date: string; acute: number; chronic: number }[];
  efficiency: { week: string; value: number | null }[];
  shoes: (Shoe & { limit: number; racing: boolean })[];
  latest: (Run & { detail: RunDetail | null; estimate: RunEstimate | null; shoe: Shoe | null }) | null;
}

const RACING = /alphafly|vaporfly|metaspeed|adios pro|endorphin pro|elite|rocket x|sc elite|supercomp elite/i;

// ---- Marathon shape -------------------------------------------------------------

export interface MarathonShape {
  total: number; // 1 = 100 %
  weekly: number;
  long: number;
  kmPerWeek: number;
  targetKm: number;
  targetLong: number;
}

const interp = (pts: [number, number][], x: number) => {
  if (x <= pts[0][0]) return pts[0][1] + ((x - pts[0][0]) * (pts[1][1] - pts[0][1])) / (pts[1][0] - pts[0][0]);
  for (let i = 1; i < pts.length; i++)
    if (x <= pts[i][0]) return pts[i - 1][1] + ((x - pts[i - 1][0]) * (pts[i][1] - pts[i - 1][1])) / (pts[i][0] - pts[i - 1][0]);
  const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  return b[1] + ((x - b[0]) * (b[1] - a[1])) / (b[0] - a[0]);
};

/**
 * Like Runalyze's marathon shape: weekly km over the last 26 weeks (2/3) and long
 * runs over the last 10 weeks (1/3), both against what a marathon at this VO2 max
 * needs, recent weeks counting more. Targets follow Runalyze's table
 * (VO2 max 50 → ~85 km/week and ~30 km long runs; 70 → ~124 and ~34).
 */
export function marathonShape(runs: Run[], today: string, vdotNow: number): MarathonShape {
  const targetKm = interp([[25, 39], [50, 85], [70, 124]], vdotNow);
  const targetLong = interp([[25, 22], [50, 30], [70, 34]], vdotNow);
  const thisMonday = mondayOf(today);
  let wSum = 0;
  let kmW = 0;
  let longW = 0;
  let lSum = 0;
  for (let i = 1; i <= 26; i++) {
    const mon = addDays(thisMonday, -7 * i);
    const wk = runs.filter((r) => r.date >= mon && r.date < addDays(mon, 7));
    const kmWeek = wk.reduce((s, r) => s + r.distance / 1000, 0);
    const w = 27 - i; // recent weeks count more
    kmW += kmWeek * w;
    wSum += w;
    if (i <= 10) {
      const longest = wk.reduce((m, r) => Math.max(m, r.distance / 1000), 0);
      const lw = 11 - i;
      longW += Math.max(0, Math.min(1, (longest - 13) / (targetLong - 13))) * lw;
      lSum += lw;
    }
  }
  const kmPerWeek = kmW / wSum;
  const weekly = Math.min(1.5, kmPerWeek / targetKm);
  const long = longW / lSum;
  return { total: (2 / 3) * weekly + (1 / 3) * long, weekly, long, kmPerWeek, targetKm, targetLong };
}

/** How much slower than the VO2 max prediction, given the shape (needs: 5k 7 %, 10k 17 %, half 43 %, marathon 100 %). */
export function shapeFactor(distance: number, shape: number): number {
  const need = distance >= 42000 ? 1 : distance >= 21000 ? 0.43 : distance >= 10000 ? 0.17 : 0.07;
  const maxPenalty = distance >= 42000 ? 0.12 : distance >= 21000 ? 0.05 : distance >= 10000 ? 0.03 : 0.02;
  return 1 + (Math.max(0, need - shape) / need) * maxPenalty;
}

// ---- Personal speed–endurance curve ---------------------------------------------

export interface RacePoint {
  date: string;
  name: string;
  distance: number; // m
  seconds: number;
}

/**
 * Riegel's time ∝ distance^k with your own k. k is fitted to your best race in
 * each distance band (≤ 7.5 km, 10 km, half, marathon) from the last 9 months:
 * runners with relatively strong endurance have a low k, speed-types a high one.
 * The curve is anchored on your best 10 km-equivalent from races in the last
 * year, or your current form when that's better.
 */
export function enduranceModel(races: RacePoint[], today: string, formTenK: number | null) {
  const DEFAULT_K = 1.07;
  const band = (m: number) => (m < 7500 ? 0 : m < 15000 ? 1 : m < 30000 ? 2 : 3);
  const recent = races.filter((r) => r.distance >= 3000 && r.date >= addDays(today, -270) && r.date <= today);
  // Best in each band by equal-endurance (VDOT) level, so a slow race in a band doesn't count.
  const best = new Map<number, RacePoint>();
  for (const r of recent) {
    const b = band(r.distance);
    const cur = best.get(b);
    if (!cur || vdot(r.distance, r.seconds) > vdot(cur.distance, cur.seconds)) best.set(b, r);
  }
  const pts = [...best.values()];
  let k = DEFAULT_K;
  let fitted = false;
  if (pts.length >= 2) {
    const xs = pts.map((p) => Math.log(p.distance));
    const ys = pts.map((p) => Math.log(p.seconds));
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    if (den > 0.1) {
      k = Math.min(1.12, Math.max(1.04, num / den));
      fitted = true;
    }
  }
  const year = races.filter((r) => r.distance >= 3000 && r.date >= addDays(today, -365) && r.date <= today);
  let ten: number | null = null;
  let anchor = "";
  for (const r of year) {
    const t = r.seconds * Math.pow(10000 / r.distance, k);
    if (ten == null || t < ten) {
      ten = t;
      anchor = r.name;
    }
  }
  if (formTenK != null && (ten == null || formTenK < ten)) {
    ten = formTenK;
    anchor = "current form";
  }
  if (ten == null) return null;
  const t10 = ten;
  return { k, ten: t10, anchor, fitted, used: pts.map((p) => p.name), predict: (m: number) => t10 * Math.pow(m / 10000, k) };
}

export function computeFitness(
  runs: Run[],
  details: Map<string, RunDetail>,
  readings: { date: string; vo2: number }[],
  shoes: Shoe[],
  config: FitnessConfig,
  plan: Plan | undefined,
  today: string,
  garminPredictions: { values: Record<string, number>; date: string; monthAgo?: Record<string, number> | null } | null = null,
): Fitness {
  // Raw estimates first, then calibrate to Garmin if there are readings.
  const raw: RunEstimate[] = [];
  for (const r of runs) {
    const d = details.get(r.id);
    if (!d) continue;
    const e = estimateRun(splitsFor(d), config);
    if (e) raw.push({ id: r.id, date: r.date, name: r.name, vo2: e.vo2, n: e.n });
  }
  // Calibrate: to Garmin readings when there are any, otherwise to race results
  // from the last year (VDOT), which also puts estimates on the same scale as the goals.
  const races = plan ? raceHistory(runs, plan).map((r) => ({ date: r.date, name: r.name, vdot: vdot(r.km * 1000, r.time) })) : [];
  const recentRaces = races.filter((r) => r.date >= addDays(today, -365)).map((r) => ({ date: r.date, vo2: r.vdot }));
  // Garmin readings are deliberately not used for this: Garmin's VO2 max is on a
  // different (usually higher) scale than VDOT, so shifting onto it would make every
  // race prediction too fast. They're compared separately below.
  let calibration: Fitness["calibration"] = "none";
  let offset = 0;
  if (config.calibrate && recentRaces.length) {
    const o = garminOffset(recentRaces, raw, 21);
    if (o != null) {
      offset = o;
      calibration = "races";
    }
  }
  const estimates = raw.map((e) => ({ ...e, vo2: e.vo2 + offset }));
  const latestReading = readings.length ? [...readings].sort((a, b) => a.date.localeCompare(b.date))[readings.length - 1] : null;
  // Wider window than calibration used to: readings are occasional.
  const gOff = latestReading ? garminOffset(readings, estimates, 28) : null;

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

  const DIST = [
    { name: "5k", distance: 5000, match: /5k/i },
    { name: "10k", distance: 10000, match: /10k/i },
    { name: "Half", distance: 21097.5, match: /half/i },
    { name: "Marathon", distance: 42195, match: /marathon/i },
  ];
  // Race predictions: what you can run when rested and sharp. Training-run estimates dip
  // after a marathon or in a recovery block, so the best race in the last year sets a floor.
  const bestRace = races.filter((r) => r.date >= addDays(today, -365)).sort((a, b) => b.vdot - a.vdot)[0];
  const predictionBasis: Fitness["predictionBasis"] =
    bestRace && (current == null || bestRace.vdot > current)
      ? { vdot: bestRace.vdot, source: "race", race: bestRace }
      : current != null
        ? { vdot: current, source: "form" }
        : null;
  const shape = predictionBasis ? marathonShape(runs, today, predictionBasis.vdot) : null;
  // Main prediction: your own speed–endurance curve from your recent races (like
  // Garmin's, it lets your marathon be relatively slower or faster than your 10k).
  const raceRows = plan ? raceHistory(runs, plan) : [];
  const endurance = enduranceModel(
    raceRows.map((r) => ({ date: r.date, name: r.name, distance: r.km * 1000, seconds: r.time })),
    today,
    current != null ? predictTime(10000, current) : null,
  );
  // The same prediction as it stood a month ago (races and form up to then), for the trend.
  const then = addDays(today, -30);
  const formThen = [...weekly].reverse().find((w) => w.week <= mondayOf(then) && w.smooth != null)?.smooth ?? null;
  const enduranceThen = enduranceModel(
    raceRows.filter((r) => r.date <= then).map((r) => ({ date: r.date, name: r.name, distance: r.km * 1000, seconds: r.time })),
    then,
    formThen != null ? predictTime(10000, formThen) : null,
  );
  const predictions = DIST.map((d) => {
    const race = plan?.races.find((r) => d.match.test(r.name) && r.date && r.date >= today);
    const targetSeconds = race ? targetTime(race.target, d.distance) : null;
    const vdotSeconds = predictionBasis ? predictTime(d.distance, predictionBasis.vdot) : null;
    return {
      name: d.name,
      distance: d.distance,
      seconds: endurance ? endurance.predict(d.distance) : vdotSeconds,
      vdotSeconds,
      shapeSeconds: vdotSeconds != null && shape ? vdotSeconds * shapeFactor(d.distance, shape.total) : null,
      formSeconds: current != null ? predictTime(d.distance, current) : null,
      garminSeconds: garminPredictions?.values[d.name] ?? null,
      garminMonthAgo: garminPredictions?.monthAgo?.[d.name] ?? null,
      monthAgoSeconds: enduranceThen ? enduranceThen.predict(d.distance) : null,
      target: race ? `${race.name}: ${race.target}` : null,
      targetSeconds,
    };
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

  // Garmin scale: anchored so that today's estimate shows exactly Garmin's latest
  // VO2 max (one number everywhere), when that reading is recent. Otherwise the
  // typical gap between readings and nearby estimates.
  const recentReading = latestReading && latestReading.date >= addDays(today, -28) ? latestReading : null;
  const anchorOff = recentReading && current != null ? recentReading.vo2 - current : gOff;
  const garminScale = latestReading && anchorOff != null ? { offset: anchorOff, latest: latestReading, equivalent: current != null ? current + anchorOff : null } : null;

  return {
    config,
    offset,
    calibration,
    garmin: garminScale,
    shift: config.displayScale !== "race" && garminScale ? garminScale.offset : 0,
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
    predictionBasis,
    endurance: endurance ? { k: endurance.k, ten: endurance.ten, anchor: endurance.anchor, fitted: endurance.fitted, used: endurance.used } : null,
    garminPredictionsDate: garminPredictions?.date ?? null,
    shape,
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
  const healthVersion = useDataVersion("health");
  const [cfgTick, setCfgTick] = useState(0);
  useEffect(() => {
    const f = () => setCfgTick((t) => t + 1);
    window.addEventListener("cc:fitness-config", f);
    return () => window.removeEventListener("cc:fitness-config", f);
  }, []);
  const from = addDays(today, -430);
  const { data } = useQuery(
    () => Promise.all([loadRuns("2024-01-01"), loadDetails(from), loadReadings(), loadShoes(), loadFitnessConfig(), latestPredictions()]),
    [version, healthVersion, today, cfgTick],
  );
  if (!data) return undefined;
  const [runs, details, readings, shoes, config, garminPred] = data;
  return computeFitness(runs, details, readings, shoes, config, plan, today, garminPred);
}

export function fitnessConfigChanged() {
  window.dispatchEvent(new Event("cc:fitness-config"));
}

export const fmtVo2 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));
/** A VO2 max number as shown: shifted onto Garmin's scale when that's chosen. */
export const showVo2 = (f: Fitness, v: number | null | undefined) => (v == null ? "–" : (v + f.shift).toFixed(1));
export { km };
