import { addDays } from "../../core/time";
import type { HealthDay } from "./data";

/**
 * Readiness worked out here, for watches that don't give Garmin's Training
 * Readiness. Four parts, each 0–100, weighted like Garmin's own score:
 *  - HRV last night against your 30-day normal (30%)
 *  - sleep last night: length, and Garmin's sleep score if there is one (25%)
 *  - resting heart rate against your 30-day average (15%)
 *  - training load: last 7 days against the 4 before (acute:chronic), and how
 *    hard yesterday and the day before were (30%)
 * A part with no data is left out and the others are re-weighted.
 */
export interface ReadinessPart {
  name: string;
  score: number;
  note: string;
}
export interface Readiness {
  score: number;
  level: "High" | "Moderate" | "Low" | "Poor";
  advice: string;
  parts: ReadinessPart[];
  /** The part pulling the score down most, if any is below 60. */
  limiter: ReadinessPart | null;
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export function ownReadiness(rows: HealthDay[], date: string, dailyLoad: { date: string; load: number }[]): Readiness | null {
  const by = new Map(rows.map((r) => [r.date, r]));
  const today = by.get(date);
  const window = rows.filter((r) => r.date < date && r.date >= addDays(date, -30));
  const parts: (ReadinessPart & { w: number })[] = [];

  // HRV
  const hrvs = window.map((r) => r.hrv).filter((x): x is number => x != null);
  if (today?.hrv != null && hrvs.length >= 5) {
    const m = mean(hrvs);
    const s = Math.max(3, sd(hrvs));
    const z = (today.hrv - m) / s;
    parts.push({ name: "HRV", w: 0.3, score: clamp(72 + 22 * z), note: `${Math.round(today.hrv)} ms vs your normal ${Math.round(m)}` });
  }
  // Sleep
  if (today?.sleep_secs != null) {
    const h = today.sleep_secs / 3600;
    let sc = clamp(((h - 5) / 3) * 100);
    if (today.sleep_score != null) sc = (sc + today.sleep_score) / 2;
    parts.push({ name: "Sleep", w: 0.25, score: sc, note: `${Math.floor(h)} h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}${today.sleep_score != null ? `, score ${Math.round(today.sleep_score)}` : ""}` });
  }
  // Resting HR
  // Garmin settles a day's resting HR as the day goes on, so early on yesterday's stands in.
  const rhrNow = today?.rhr ?? by.get(addDays(date, -1))?.rhr ?? null;
  const rhrs = window.filter((r) => r.date < addDays(date, -1)).map((r) => r.rhr).filter((x): x is number => x != null);
  if (rhrNow != null && rhrs.length >= 5) {
    const diff = rhrNow - mean(rhrs);
    parts.push({ name: "Resting HR", w: 0.15, score: clamp(82 - diff * 9), note: `${Math.round(rhrNow)} bpm (${diff >= 0 ? "+" : ""}${diff.toFixed(1)} vs normal)` });
  }
  // Load
  const loadOn = (d: string) => dailyLoad.filter((x) => x.date === d).reduce((a, b) => a + b.load, 0);
  const sum = (from: string, to: string) => dailyLoad.filter((x) => x.date > from && x.date <= to).reduce((a, b) => a + b.load, 0);
  const yesterday = addDays(date, -1);
  const acute = sum(addDays(date, -8), yesterday);
  const chronic = sum(addDays(date, -29), yesterday) / 4;
  if (chronic > 0) {
    const r = acute / chronic;
    let sc = r <= 1 ? 92 : r <= 1.3 ? 92 - ((r - 1) / 0.3) * 25 : r <= 1.6 ? 67 - ((r - 1.3) / 0.3) * 40 : 20;
    const y1 = loadOn(yesterday);
    const y2 = loadOn(addDays(date, -2));
    sc -= Math.max(0, y1 - 70) * 0.25 + Math.max(0, y2 - 70) * 0.1;
    parts.push({ name: "Training load", w: 0.3, score: clamp(sc), note: `last 7 days ${Math.round((r) * 100)}% of usual${y1 > 120 ? " · hard day yesterday" : ""}` });
  }

  // Without last night (HRV or sleep) there is nothing to say about today yet.
  if (!parts.some((p) => p.name === "HRV" || p.name === "Sleep")) return null;
  const wsum = parts.reduce((a, p) => a + p.w, 0);
  const score = Math.round(parts.reduce((a, p) => a + p.score * p.w, 0) / wsum);
  const level = score >= 75 ? "High" : score >= 50 ? "Moderate" : score >= 25 ? "Low" : "Poor";
  const advice =
    level === "High" ? "Ready for a key session" : level === "Moderate" ? "Fine for planned training" : level === "Low" ? "Keep today easy" : "Rest or very easy";
  const worst = [...parts].sort((a, b) => a.score - b.score)[0];
  const strip = ({ w: _w, ...p }: ReadinessPart & { w: number }) => p;
  return { score, level, advice, parts: parts.map(strip), limiter: worst.score < 60 ? strip(worst) : null };
}
