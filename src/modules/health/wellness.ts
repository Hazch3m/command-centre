import { addDays } from "../../core/time";
import type { HealthDay } from "./data";

/*
 * Daily wellness numbers (resting heart rate, HRV, sleep, Body Battery) as averages: the last 7 and 30 days, and
 * the lowest (and highest) 30-day average on record. Used by the progress chart and the Claude connector.
 * A 30-day average needs at least 15 days with a value in the window, a 7-day one at least 4.
 */

export type WellnessKey = "rhr" | "hrv" | "sleep_secs" | "sleep_score" | "bb_high";

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

/** The average of `key` over the `n` days ending on `end` (null with too few values). */
export function windowAvg(rows: HealthDay[], key: WellnessKey, end: string, n: number): number | null {
  const from = addDays(end, -(n - 1));
  const xs = rows.filter((r) => r.date >= from && r.date <= end && typeof r[key] === "number").map((r) => r[key] as number);
  return xs.length >= (n >= 30 ? 15 : Math.min(4, n)) ? mean(xs) : null;
}

/** Rolling `n`-day averages, one per day from the first full window to `to`. */
export function rolling(rows: HealthDay[], key: WellnessKey, n: number, to: string): { date: string; value: number }[] {
  const have = rows.filter((r) => typeof r[key] === "number").sort((a, b) => a.date.localeCompare(b.date));
  if (!have.length) return [];
  const out: { date: string; value: number }[] = [];
  // A running window over the sorted values.
  let lo = 0;
  let sum = 0;
  let hi = 0;
  for (let d = addDays(have[0].date, n - 1); d <= to; d = addDays(d, 1)) {
    const from = addDays(d, -(n - 1));
    while (hi < have.length && have[hi].date <= d) sum += have[hi++][key] as number;
    while (lo < hi && have[lo].date < from) sum -= have[lo++][key] as number;
    const count = hi - lo;
    if (count >= (n >= 30 ? 15 : Math.min(4, n))) out.push({ date: d, value: sum / count });
  }
  return out;
}

export interface WellnessSummary {
  last_7_days: number | null;
  last_30_days: number | null;
  lowest_30_day_average: { value: number; period_end: string } | null;
  highest_30_day_average: { value: number; period_end: string } | null;
}

export function summarize(rows: HealthDay[], key: WellnessKey, today: string): WellnessSummary {
  const roll = rolling(rows, key, 30, today);
  const lo = roll.reduce<(typeof roll)[number] | null>((a, p) => (!a || p.value <= a.value ? p : a), null);
  const hi = roll.reduce<(typeof roll)[number] | null>((a, p) => (!a || p.value >= a.value ? p : a), null);
  return {
    last_7_days: windowAvg(rows, key, today, 7),
    last_30_days: windowAvg(rows, key, today, 30),
    lowest_30_day_average: lo ? { value: lo.value, period_end: lo.date } : null,
    highest_30_day_average: hi ? { value: hi.value, period_end: hi.date } : null,
  };
}
