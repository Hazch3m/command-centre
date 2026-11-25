import { addDays, diffDays } from "../../core/time";
import { forecastWeek } from "./forecast";
import { mondayOf, type Plan } from "./plan";
import type { Run } from "./strava";

/*
 * Progression markers for the Progress page: is the aerobic engine improving (easy pace at a fixed heart rate),
 * are the sessions getting quicker for the same heart rate, and is the training happening (planned vs done).
 * Each one is a number, a trend and the runs behind it.
 */

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------------------------------------------
// Aerobic engine: easy pace at a fixed heart rate

/** The reference heart rate: about 70% of max, rounded to 5 (140 at a max of 199). */
export const refHr = (hrMax: number) => Math.round((hrMax * 0.705) / 5) * 5;

/**
 * Pace (s/km) a run would have been at the reference heart rate: its metres per heartbeat × the reference.
 * Only steady, flat-ish runs near the reference count: 6 km or more, average heart rate within 12 bpm of it and
 * under 15 m of climb per km.
 */
export function paceAtHr(r: Run, ref: number): number | null {
  if (!r.avg_hr || r.moving_time <= 0 || r.distance < 6000) return null;
  if (Math.abs(r.avg_hr - ref) > 12) return null;
  if (r.elevation / (r.distance / 1000) > 15) return null;
  const perBeat = r.distance / (r.avg_hr * (r.moving_time / 60));
  return 1000 / ((perBeat * ref) / 60);
}

export interface MonthPoint {
  month: string; // YYYY-MM
  pace: number; // s/km at the reference heart rate (median of the month's runs)
  runs: number;
}

/** Month by month (at least 2 runs a month), the last `months` months. */
export function aerobicTrend(runs: Run[], hrMax: number, today: string, months = 12): { ref: number; points: MonthPoint[] } {
  const ref = refHr(hrMax);
  const from = addDays(today, -months * 31);
  const by = new Map<string, number[]>();
  for (const r of runs) {
    if (r.date < from || r.date > today || !/run/i.test(r.sport)) continue;
    const p = paceAtHr(r, ref);
    if (p == null || p < 150 || p > 600) continue;
    const m = r.date.slice(0, 7);
    by.set(m, [...(by.get(m) ?? []), p]);
  }
  const points = [...by.entries()]
    .filter(([, xs]) => xs.length >= 2)
    .map(([month, xs]) => ({ month, pace: median(xs)!, runs: xs.length }))
    .sort((a, b) => a.month.localeCompare(b.month));
  return { ref, points };
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions

export type SessionKind = "Threshold" | "VO2 max" | "10k pace" | "Marathon pace";

/** What kind of session a planned session is (null for easy and long runs). */
export function sessionKind(text: string): SessionKind | null {
  if (/VO2 max:|5K pace:|30\/15/i.test(text)) return "VO2 max";
  if (/10K pace:/i.test(text)) return "10k pace";
  if (/Threshold|tempo/i.test(text)) return "Threshold";
  if (/Marathon pace:/i.test(text)) return "Marathon pace";
  if (/judged as (Interval|VO2|5k)/i.test(text)) return "VO2 max";
  if (/judged as (Threshold|10k)/i.test(text)) return /10k/i.test(text) ? "10k pace" : "Threshold";
  if (/judged as Marathon/i.test(text)) return "Marathon pace";
  return null;
}

export interface SessionPoint {
  date: string;
  runId: string;
  kind: SessionKind;
  label: string;
  /** Work pace and target (s/km), and the work's heart rate when the watch laps have it. */
  pace: number;
  target: [number, number];
  hr: number | null;
  onTarget: boolean;
}

/** First and latest of a kind in the window: the change in pace and heart rate. */
export function sessionChange(points: SessionPoint[], kind: SessionKind) {
  const xs = points.filter((p) => p.kind === kind).sort((a, b) => a.date.localeCompare(b.date));
  if (xs.length < 2) return null;
  const a = xs[0];
  const b = xs[xs.length - 1];
  return { first: a, last: b, pace: b.pace - a.pace, hr: a.hr != null && b.hr != null ? b.hr - a.hr : null, n: xs.length };
}

// ---------------------------------------------------------------------------------------------------------------
// Consistency: the plan against what you ran

export interface WeekDone {
  monday: string;
  planned: number | null;
  done: number;
  keysPlanned: number;
  keysDone: number;
  longest: number;
}

export function consistency(plan: Plan, runs: Run[], today: string, weeks = 12, overrides?: Map<string, string>): WeekDone[] {
  const out: WeekDone[] = [];
  const thisMonday = mondayOf(today);
  for (let k = weeks - 1; k >= 0; k--) {
    const m = addDays(thisMonday, -7 * k);
    const fw = forecastWeek(plan, m, runs, overrides);
    const past = fw.days.filter((d) => d.date <= today);
    const done = fw.days.reduce((a, d) => a + d.runs.reduce((s, r) => s + r.distance / 1000, 0), 0);
    const keys = past.filter((d) => d.kind === "key" || (d.kind === "long" && /at MP|\bat \d:\d\d/.test(d.text)));
    out.push({
      monday: m,
      planned: fw.week ? fw.plannedKm : null,
      done: Math.round(done * 10) / 10,
      keysPlanned: keys.length,
      keysDone: keys.filter((d) => d.runs.length).length,
      longest: Math.round(Math.max(0, ...fw.days.flatMap((d) => d.runs.map((r) => r.distance / 1000))) * 10) / 10,
    });
  }
  return out;
}

/** Totals over complete weeks (this week left out): km against plan and sessions done. */
export function consistencySummary(ws: WeekDone[], today: string) {
  const full = ws.filter((w) => diffDays(w.monday, today) >= 7);
  const planned = full.filter((w) => w.planned);
  const km = planned.reduce((a, w) => a + w.done, 0);
  const plannedKm = planned.reduce((a, w) => a + (w.planned ?? 0), 0);
  const keysPlanned = full.reduce((a, w) => a + w.keysPlanned, 0);
  const keysDone = full.reduce((a, w) => a + w.keysDone, 0);
  const last4 = full.slice(-4);
  return {
    weeks: full.length,
    kmShare: plannedKm ? km / plannedKm : null,
    keysShare: keysPlanned ? keysDone / keysPlanned : null,
    keysPlanned,
    keysDone,
    avg4: last4.length ? last4.reduce((a, w) => a + w.done, 0) / last4.length : null,
    planned4: last4.filter((w) => w.planned).length ? last4.reduce((a, w) => a + (w.planned ?? 0), 0) / last4.filter((w) => w.planned).length : null,
    longest: Math.max(0, ...full.slice(-8).map((w) => w.longest)),
  };
}
