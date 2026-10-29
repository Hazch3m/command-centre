import { addDays, diffDays } from "../../core/time";
import { mondayOf, type Benchmark, type Plan } from "./plan";
import type { Run } from "./strava";

export const km = (m: number) => m / 1000;

/** "4:12" per km from metres and seconds. */
export function pace(distanceM: number, seconds: number): string {
  if (!distanceM) return "–";
  const s = Math.round(seconds / (distanceM / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

/** "17:20", "1:18:30" → seconds. */
export function parseTime(t: string): number | null {
  const m = /(\d+):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return null;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

export interface WeekTotal {
  week: string; // Monday
  km: number;
  runs: number;
  longest: number;
}

/** Totals per Monday–Sunday week from `fromMonday` to `toMonday`, including empty weeks. */
export function weeklyTotals(runs: Run[], fromMonday: string, toMonday: string): WeekTotal[] {
  const map = new Map<string, WeekTotal>();
  for (let w = fromMonday; w <= toMonday; w = addDays(w, 7)) map.set(w, { week: w, km: 0, runs: 0, longest: 0 });
  for (const r of runs) {
    const w = map.get(mondayOf(r.date));
    if (!w) continue;
    const k = km(r.distance);
    w.km += k;
    w.runs += 1;
    w.longest = Math.max(w.longest, k);
  }
  return [...map.values()];
}

export interface DayCell {
  date: string;
  km: number;
  runs: Run[];
}

/** The 7 days of the week containing `today`, with what was run each day. */
export function weekDays(runs: Run[], today: string): DayCell[] {
  const mon = mondayOf(today);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mon, i);
    const rs = runs.filter((r) => r.date === date);
    return { date, km: rs.reduce((s, r) => s + km(r.distance), 0), runs: rs };
  });
}

/** Last 52 complete weeks: average, empty weeks and long runs, as on the progression review. */
export function yearSummary(runs: Run[], today: string) {
  const thisMonday = mondayOf(today);
  const weeks = weeklyTotals(runs, addDays(thisMonday, -52 * 7), addDays(thisMonday, -7));
  const avg = weeks.reduce((s, w) => s + w.km, 0) / Math.max(1, weeks.length);
  return {
    avgKm: avg,
    weeksUnder15: weeks.filter((w) => w.km < 15).length,
    runs30Plus: runs.filter((r) => r.date >= weeks[0]?.week && km(r.distance) >= 30).length,
    weeks,
  };
}

/** Riegel: equivalent marathon time from a race of `distKm` in `seconds`. */
export function marathonEquivalent(seconds: number, distKm: number) {
  return seconds * Math.pow(42.195 / distKm, 1.06);
}

export interface RaceRow {
  id: string;
  name: string;
  date: string;
  km: number;
  time: number;
  equiv: number;
}

const STANDARD = [5, 10, 21.0975, 42.195];

/**
 * Past races: the curated list from the plan, plus any later run Strava marks
 * as a race (distance rounded to the nearest standard distance when close).
 */
export function raceHistory(runs: Run[], plan: Plan): RaceRow[] {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const curated = plan.history?.races ?? [];
  const rows: RaceRow[] = [];
  for (const c of curated) {
    const r = byId.get(c.id);
    if (r) rows.push({ id: r.id, name: c.name, date: r.date, km: c.km, time: r.elapsed_time, equiv: marathonEquivalent(r.elapsed_time, c.km) });
  }
  const lastCurated = rows.reduce((d, r) => (r.date > d ? r.date : d), "");
  for (const r of runs) {
    if (r.workout_type !== 1 || r.date <= lastCurated || curated.some((c) => c.id === r.id)) continue;
    const raw = km(r.distance);
    const std = STANDARD.find((s) => Math.abs(raw - s) / s < 0.03) ?? Math.round(raw * 10) / 10;
    rows.push({ id: r.id, name: r.name, date: r.date, km: std, time: r.elapsed_time, equiv: marathonEquivalent(r.elapsed_time, std) });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/** The 16 weeks before each marathon, as compared on the progression review. */
export function marathonBlocks(runs: Run[], plan: Plan) {
  return (plan.history?.marathons ?? []).map((m) => {
    const start = addDays(m.date, -112);
    const weeks = new Array(16).fill(0) as number[];
    let longest = 0;
    let n30 = 0;
    for (const r of runs) {
      if (r.date < start || r.date >= m.date) continue;
      const k = km(r.distance);
      weeks[Math.floor(diffDays(start, r.date) / 7)] += k;
      longest = Math.max(longest, k);
      if (k >= 30) n30++;
    }
    const race = runs.filter((r) => r.date === m.date).sort((a, b) => b.distance - a.distance)[0];
    return {
      name: m.name,
      date: m.date,
      avgKm: weeks.reduce((s, x) => s + x, 0) / 16,
      weeksUnder30: weeks.filter((x) => x < 30).length,
      runs30Plus: n30,
      longest,
      result: race ? (race.distance >= 42000 ? duration(race.elapsed_time) : `DNF at ${Math.round(km(race.distance))} km`) : "–",
    };
  });
}

export type BenchStatus = "on-track" | "between" | "behind" | "pending" | "manual";

/**
 * Compares a benchmark result with the plan's thresholds ("17:20 or faster",
 * "slower than 17:40"). Session benchmarks (heart-rate based) can't be judged
 * automatically.
 */
export function judgeBenchmark(b: Benchmark, resultSeconds: number | null): BenchStatus {
  const good = parseTime(b.onTrack);
  const bad = parseTime(b.behind);
  if (good == null || bad == null || !/faster/.test(b.onTrack)) return "manual";
  if (resultSeconds == null) return "pending";
  if (resultSeconds <= good) return "on-track";
  if (resultSeconds > bad) return "behind";
  return "between";
}

/** The race run on a benchmark's date (longest run that day, preferring Strava's race flag). */
export function resultOn(runs: Run[], date: string | null): Run | null {
  if (!date) return null;
  const day = runs.filter((r) => r.date === date);
  return day.find((r) => r.workout_type === 1) ?? day.sort((a, b) => b.distance - a.distance)[0] ?? null;
}
