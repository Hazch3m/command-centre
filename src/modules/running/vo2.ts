/**
 * VO2 max from Strava data, Garmin-style.
 *
 * Per run: each steady 1 km split above 80% of max heart rate gives one
 * estimate. Daniels' oxygen-cost equation turns grade-adjusted speed into VO2,
 * and heart-rate reserve gives the fraction of VO2 max being used (Swain:
 * %VO2 reserve ≈ %HR reserve). The run's value is the median of its splits.
 * Runs with at least MIN_SPLITS such splits are "key runs" and feed the weekly
 * trend, which is compared with a projection towards your race goals.
 */
import { addDays, diffDays } from "../../core/time";

export interface Split {
  distance: number; // m
  moving_time: number; // s
  speed: number; // m/s, grade-adjusted when Strava provides it
  hr: number | null;
}

export interface Vo2Config {
  hrMax: number;
  hrRest: number;
  /** Garmin calibration: added to every estimate (median Garmin − estimate). Computed, not edited. */
  offset?: number;
  projection: { start: { date: string; vo2: number | null }; milestones: { date: string; vo2: number; label: string }[] };
  /** How effective VO2 max is worked out (like Runalyze's settings). */
  calc?: Vo2Calc;
}

/** Your own tweaks to the effective VO2 max: all optional, the defaults are as before. */
export interface Vo2Calc {
  /** Days of runs in the smoothed value (default 28). */
  smoothDays?: number;
  /** Splits count from this share of max heart rate (default 0.8). */
  minHr?: number;
  /** Use grade-adjusted pace when there is one (default true). */
  gap?: boolean;
  /** "auto": put estimates on your race results' scale; "off": raw; a number: add it yourself. */
  correction?: "auto" | "off" | number;
}

export const MIN_SPLITS = 3;

/** Daniels & Gilbert oxygen cost of running at v metres per minute (ml/kg/min). */
export function oxygenCost(vMetresPerMin: number): number {
  return -4.6 + 0.182258 * vMetresPerMin + 0.000104 * vMetresPerMin * vMetresPerMin;
}

/** Fraction of VO2 max sustainable for a race lasting t minutes (Daniels). */
export function sustainableFraction(tMin: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
}

/** VDOT (Daniels' effective VO2 max) from a race result. */
export function vdot(distanceM: number, seconds: number): number {
  const t = seconds / 60;
  return oxygenCost(distanceM / t) / sustainableFraction(t);
}

/** Predicted race time (seconds) for a given VDOT, by bisection. */
export function predictTime(distanceM: number, v: number): number {
  let lo = (distanceM / 1000) * 120; // 2:00/km
  let hi = (distanceM / 1000) * 600; // 10:00/km
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (vdot(distanceM, mid) > v) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** VO2 max a lap is worth from its pace and heart rate (null when the heart rate is too low to say). */
export function lapVo2(l: { speed: number; hr?: number | null; moving_time: number }, cfg: Vo2Config): number | null {
  if (!l.hr || l.speed <= 0 || l.moving_time < 60 || l.hr < 0.75 * cfg.hrMax || l.hr >= cfg.hrMax) return null;
  return splitEstimate({ distance: 0, moving_time: l.moving_time, speed: l.speed, hr: l.hr }, cfg);
}

function splitEstimate(s: Split, cfg: Vo2Config): number {
  const hrr = (s.hr! - cfg.hrRest) / (cfg.hrMax - cfg.hrRest);
  return (oxygenCost(s.speed * 60) - 3.5) / hrr + 3.5;
}

/**
 * Estimate from one run's 1 km splits. A split counts when it's a full
 * kilometre, hard enough (≥80% HRmax, which also screens out optical-sensor dropouts) and steady: heart rate within 7 bpm and
 * speed within 6% of the previous split, so heart-rate lag after a surge
 * doesn't skew it. The first kilometre (warm-up drift) never counts.
 */
export function estimateRun(splits: Split[], cfg: Vo2Config): { vo2: number; n: number } | null {
  const vals: number[] = [];
  let covered = 0;
  for (let i = 1; i < splits.length; i++) {
    const s = splits[i];
    const p = splits[i - 1];
    covered += p.distance;
    // Past ~30 km heart rate drifts up at the same pace (dehydration, heat), which
    // would read as lower fitness; steady-state methods like Garmin's skip it.
    if (covered + s.distance > 30000) break;
    if (!s.hr || !p.hr || s.distance < 900 || s.moving_time < 150 || s.speed <= 0) continue;
    if (s.hr < (cfg.calc?.minHr ?? 0.8) * cfg.hrMax || s.hr >= cfg.hrMax) continue;
    if (Math.abs(s.hr - p.hr) > 7 || p.distance < 900) continue;
    if (Math.abs(s.speed - p.speed) / s.speed > 0.06) continue;
    const e = splitEstimate(s, cfg);
    if (e > 25 && e < 90) vals.push(e);
  }
  if (vals.length < MIN_SPLITS) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  const median = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  return { vo2: median, n: vals.length };
}

export interface RunEstimate {
  id: string;
  date: string;
  name: string;
  vo2: number; // calibrated
  n: number;
}

/** Projection value on a date: linear between start and each milestone, flat after the last. */
export function projectionAt(date: string, start: { date: string; vo2: number }, milestones: { date: string; vo2: number }[]): number {
  const pts = [start, ...milestones.filter((m) => m.date > start.date).sort((a, b) => a.date.localeCompare(b.date))];
  if (date <= pts[0].date) return pts[0].vo2;
  for (let i = 1; i < pts.length; i++) {
    if (date <= pts[i].date) {
      const f = diffDays(pts[i - 1].date, date) / diffDays(pts[i - 1].date, pts[i].date);
      return pts[i - 1].vo2 + f * (pts[i].vo2 - pts[i - 1].vo2);
    }
  }
  return pts[pts.length - 1].vo2;
}

export interface WeekPoint {
  week: string; // Monday
  value: number | null; // median of key runs that week
  smooth: number | null; // 4-week rolling median of key-run estimates
  runs: RunEstimate[];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mondayOf = (d: string) => {
  const [y, m, dd] = d.split("-").map(Number);
  const dow = new Date(y, m - 1, dd).getDay();
  return addDays(d, -((dow + 6) % 7));
};

export function weeklySeries(estimates: RunEstimate[], fromMonday: string, toMonday: string, smoothDays = 28): WeekPoint[] {
  const out: WeekPoint[] = [];
  for (let w = fromMonday; w <= toMonday; w = addDays(w, 7)) {
    const runs = estimates.filter((e) => mondayOf(e.date) === w);
    const window = estimates.filter((e) => e.date > addDays(w, 7 - smoothDays) && e.date <= addDays(w, 6)).map((e) => e.vo2);
    out.push({ week: w, value: median(runs.map((r) => r.vo2)), smooth: window.length >= 2 ? median(window) : null, runs });
  }
  return out;
}

export type TrendStatus = "ahead" | "on-track" | "behind" | "no-data";

export function judge(value: number | null, projected: number): TrendStatus {
  if (value == null) return "no-data";
  const d = value - projected;
  if (d >= 0.75) return "ahead";
  if (d >= -1.0) return "on-track";
  return "behind";
}

/**
 * Calibration: median difference between reference values (Garmin readings, or
 * race results as VDOT) and our estimates from runs within `windowDays` of each.
 */
export function garminOffset(readings: { date: string; vo2: number }[], estimates: RunEstimate[], windowDays = 14, q = 0.5): number | null {
  const diffs: number[] = [];
  for (const r of readings) {
    const near = estimates.filter((e) => Math.abs(diffDays(e.date, r.date)) <= windowDays).map((e) => e.vo2);
    const m = median(near);
    if (m != null) diffs.push(r.vo2 - m);
  }
  return quantile(diffs, q);
}

/** Linear-interpolated quantile (q = 0.5 is the median). */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/** Least-squares slope (per week) of the last `n` weekly values. */
export function slopePerWeek(points: WeekPoint[], n = 8): number | null {
  const pts = points.slice(-n).map((p, i) => [i, p.value] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (pts.length < 4) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const num = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  const den = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  return den ? num / den : null;
}

// ---- Training load (Banister TRIMP) ------------------------------------------

/** Training impulse for one run from average heart rate; ~1 point per easy minute. */
export function trimp(movingSeconds: number, avgHr: number | null, cfg: Vo2Config): number {
  const min = movingSeconds / 60;
  if (!avgHr) return min * 0.9; // no heart rate: treat as easy running
  const hrr = Math.max(0, Math.min(1, (avgHr - cfg.hrRest) / (cfg.hrMax - cfg.hrRest)));
  return min * hrr * 0.64 * Math.exp(1.92 * hrr);
}

export type LoadStatus = "low" | "optimal" | "high" | "very-high";

/** Acute (7-day) vs chronic (28-day, per-week average) load. */
export function loadRatio(daily: { date: string; load: number }[], today: string) {
  const sum = (from: string) => daily.filter((d) => d.date > from && d.date <= today).reduce((s, d) => s + d.load, 0);
  const acute = sum(addDays(today, -7));
  const chronic = sum(addDays(today, -28)) / 4;
  const ratio = chronic > 0 ? acute / chronic : null;
  const status: LoadStatus | null = ratio == null ? null : ratio < 0.8 ? "low" : ratio <= 1.3 ? "optimal" : ratio <= 1.5 ? "high" : "very-high";
  return { acute, chronic, ratio, status };
}
