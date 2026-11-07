import { addDays } from "../../core/time";
import { zoneOf, type Zones } from "./hrZones";
import type { Run, RunDetail } from "./strava";
import { trimp, type Vo2Config } from "./vo2";

/**
 * Runalyze-style training numbers from your runs' heart rate:
 * fitness (CTL, 42-day), fatigue (ATL, 7-day) and form (TSB = fitness − fatigue),
 * Foster's monotony and strain for the last week, and time in each heart-rate zone.
 */

export type Hr = Pick<Vo2Config, "hrMax" | "hrRest">;

/** Training load (TRIMP) per day. */
export function dailyLoad(runs: Pick<Run, "date" | "moving_time" | "avg_hr">[], hr: Hr): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of runs) out.set(r.date, (out.get(r.date) ?? 0) + trimp(r.moving_time, r.avg_hr ?? null, hr as Vo2Config));
  return out;
}

export interface LoadPoint {
  date: string;
  load: number;
  /** Fitness: 42-day exponentially weighted load. */
  ctl: number;
  /** Fatigue: 7-day exponentially weighted load. */
  atl: number;
  /** Form: yesterday's fitness minus fatigue (positive = fresh). */
  tsb: number;
}

/** Day-by-day fitness, fatigue and form from `from` to `to` (warmed up over the 120 days before). */
export function loadSeries(daily: Map<string, number>, from: string, to: string): LoadPoint[] {
  const kc = 1 - Math.exp(-1 / 42);
  const ka = 1 - Math.exp(-1 / 7);
  let ctl = 0;
  let atl = 0;
  const out: LoadPoint[] = [];
  for (let d = addDays(from, -120); d <= to; d = addDays(d, 1)) {
    const load = daily.get(d) ?? 0;
    const tsb = ctl - atl;
    ctl += (load - ctl) * kc;
    atl += (load - atl) * ka;
    if (d >= from) out.push({ date: d, load, ctl, atl, tsb });
  }
  return out;
}

export type FormLevel = "fresh" | "neutral" | "productive" | "tired" | "overload";
/** How form reads (Runalyze/TrainingPeaks bands, as a share of fitness so it works at any volume). */
export function formLevel(p: Pick<LoadPoint, "ctl" | "tsb">): FormLevel {
  const rel = p.ctl > 0 ? p.tsb / p.ctl : 0;
  if (rel > 0.15) return "fresh";
  if (rel > -0.1) return "neutral";
  if (rel > -0.3) return "productive";
  if (rel > -0.5) return "tired";
  return "overload";
}
export const FORM_TEXT: Record<FormLevel, string> = {
  fresh: "Fresh: rested and ready to race, though fitness fades if it stays like this",
  neutral: "Steady: training and recovery in balance",
  productive: "Productive: the training is landing, keep the easy days easy",
  tired: "Tired: a lot of recent load, an easier day or two would help it sink in",
  overload: "Overloaded: well above what you're used to, a real risk of illness or injury",
};

/** Foster's monotony (mean ÷ spread of the last 7 days' load) and strain (week's load × monotony). */
export function monotony(daily: Map<string, number>, today: string): { monotony: number | null; strain: number; week: number } {
  const xs = Array.from({ length: 7 }, (_, i) => daily.get(addDays(today, -i)) ?? 0);
  const week = xs.reduce((a, b) => a + b, 0);
  const mean = week / 7;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / 7);
  // Every day the same (spread ~0): off the scale, reported as null.
  const m = sd > mean * 0.02 ? mean / sd : null;
  return { monotony: m, strain: m == null ? 0 : week * m, week };
}

/** Minutes in each zone since `from`: by each kilometre's heart rate where the run has splits, else the run's average. */
export function zoneMinutes(
  runs: Pick<Run, "id" | "date" | "moving_time" | "avg_hr">[],
  zones: Pick<Zones, "floors">,
  from: string,
  details?: Map<string, Pick<RunDetail, "splits">>,
): { zone: number; minutes: number }[] {
  const m = [0, 0, 0, 0, 0];
  for (const r of runs) {
    if (r.date < from) continue;
    const splits = details?.get(r.id)?.splits?.filter((s) => s.hr && s.moving_time > 0);
    if (splits?.length) for (const s of splits) m[zoneOf(s.hr!, zones) - 1] += s.moving_time / 60;
    else if (r.avg_hr) m[zoneOf(r.avg_hr, zones) - 1] += r.moving_time / 60;
  }
  return m.map((minutes, i) => ({ zone: i + 1, minutes }));
}

/** Share of time easy (zones 1–2): the 80/20 check. */
export function easyShare(z: { zone: number; minutes: number }[]): number | null {
  const all = z.reduce((a, x) => a + x.minutes, 0);
  return all > 0 ? z.filter((x) => x.zone <= 2).reduce((a, x) => a + x.minutes, 0) / all : null;
}
