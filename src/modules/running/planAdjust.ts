import { addDays } from "../../core/time";
import { forecastWeek, fullWeekSessions, type ForecastDay } from "./forecast";
import { WEEK_KEYS, type DayKey, type Plan, type PlanWeek } from "./plan";

/**
 * Your own settings on top of the plan, like Runna's plan settings: how much
 * weekly mileage, how long the long runs are, and which days you run. They're
 * kept separately from the plan (in the plan file, as `adjust`), so they can be
 * changed or undone at any time, and are applied when the plan is loaded.
 */
export interface PlanAdjust {
  /** Weekly km, as a share of the plan's (0.8–1.25). */
  volume: number;
  /** Added to (or taken off) every long run, km. */
  longExtra: number;
  /** No long run longer than this, km (null = as planned). */
  longMax: number | null;
  /** Days you run, at least 3 (null = the days each week of the plan has). */
  runDays: DayKey[] | null;
  /** Where the long run goes (null = where the plan has it). */
  longDay: DayKey | null;
  /** First Monday the settings apply to (earlier weeks stay as they were). */
  from: string;
}

export const ADJUST_DEFAULTS: Omit<PlanAdjust, "from"> = {
  volume: 1,
  longExtra: 0,
  longMax: null,
  runDays: null,
  longDay: null,
};
const FALLBACK_DAYS: DayKey[] = ["tue", "wed", "thu", "sat", "sun"];

/** The plan's usual run days and long-run day, to show what "as planned" means in the settings. */
export function planDefaults(plan: Plan, from: string): { runDays: DayKey[]; longDay: DayKey } {
  const count = new Map<DayKey, number>();
  const longs = new Map<DayKey, number>();
  for (const w of plan.weeks.filter((x) => x.start >= from).slice(0, 8)) {
    forecastWeek(plan, w.start).days.forEach((d, i) => {
      const k = WEEK_KEYS[i];
      if ((d.km ?? 0) > 0) count.set(k, (count.get(k) ?? 0) + 1);
      if (d.kind === "long") longs.set(k, (longs.get(k) ?? 0) + 1);
    });
  }
  const runDays = WEEK_KEYS.filter((k) => (count.get(k) ?? 0) >= 4);
  const longDay = [...longs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "sun";
  return { runDays: runDays.length >= 3 ? runDays : FALLBACK_DAYS, longDay };
}

export const isAdjusted = (a: PlanAdjust | undefined | null) => !!a && (a.volume !== 1 || a.longExtra !== 0 || a.longMax != null || a.longDay != null || a.runDays != null);

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const IDX = (k: DayKey) => WEEK_KEYS.indexOf(k);

/** Replaces the leading distance of a session ("32 km, last 15 at…" → "34 km, last 15 at…"). */
function withKm(text: string, km: number, fallback: string): string {
  return /^\d+(?:\.\d+)?\s*km\b/i.test(text.trim()) ? text.trim().replace(/^\d+(?:\.\d+)?/, String(km)) : `${km} km ${fallback}`;
}

/** One week reshaped by the settings. */
export function adjustWeek(plan: Plan, week: PlanWeek, a: PlanAdjust): PlanWeek {
  if (week.start < a.from) return week;
  const days = forecastWeek(plan, week.start).days;
  if (!days.some((d) => (d.km ?? 0) > 0)) return week;
  const race = days.findIndex((d) => d.race || d.kind === "race");
  const longI = days.findIndex((d) => d.kind === "long");
  const longDay: DayKey = a.longDay ?? (longI >= 0 ? WEEK_KEYS[longI] : "sun");
  const own = WEEK_KEYS.filter((_k, i) => (days[i].km ?? 0) > 0 && i !== race);
  const run = new Set(a.runDays && a.runDays.length >= 3 ? a.runDays : own.length >= 3 ? own : FALLBACK_DAYS);
  if (longI >= 0 || a.longDay) run.add(longDay);
  const keys = days.map((d, i) => ({ d, i })).filter(({ d, i }) => d.kind === "key" && i !== race);
  const easy = days.map((d, i) => ({ d, i })).filter(({ d, i }) => (d.kind === "easy" || d.kind === "optional") && (d.km ?? 0) > 0 && i !== race && i !== longI);
  const total = days.reduce((s, d) => s + (d.km ?? 0), 0);
  const raceKm = race >= 0 ? days[race].km ?? 0 : 0;
  const target = Math.round((total - raceKm) * a.volume);

  const out: (null | { text: string; km: number; kind: "race" | "long" | "key" | "easy" })[] = Array(7).fill(null);
  if (race >= 0) out[race] = { text: "", km: raceKm, kind: "race" };

  // The long run: scaled with the mileage (at half the rate), then your change and cap.
  let longKm = 0;
  if (longI >= 0) {
    const base = days[longI].km ?? 0;
    longKm = Math.round(base * (1 + (a.volume - 1) * 0.5) + a.longExtra);
    if (a.longMax != null) longKm = Math.min(longKm, a.longMax);
    longKm = Math.max(10, longKm);
    // Race weeks keep the long run where the plan put it.
    const at = race >= 0 ? longI : IDX(longDay);
    const slot = out[at] ? longI : at;
    out[slot] = { text: withKm(days[longI].text, longKm, "long run"), km: longKm, kind: "long" };
  }

  // Sessions stay on their day when it's a run day, else move to the nearest free run day, not next to the long run if avoidable.
  const longAt = out.findIndex((x) => x?.kind === "long");
  for (const { d, i } of keys) {
    const free = (j: number) => j >= 0 && j < 7 && !out[j] && run.has(WEEK_KEYS[j]);
    const nearLong = (j: number) => longAt >= 0 && Math.abs(j - longAt) === 1;
    let at = free(i) && !nearLong(i) ? i : -1;
    for (let r = 1; at < 0 && r < 7; r++) for (const j of [i - r, i + r]) if (at < 0 && free(j) && !nearLong(j)) at = j;
    for (let r = 0; at < 0 && r < 7; r++) for (const j of [i - r, i + r]) if (at < 0 && free(j)) at = j;
    if (at >= 0) out[at] = { text: d.text, km: d.km ?? 0, kind: "key" };
  }

  // Easy days fill what's left of the week's target. The plan's easy runs keep their sizes relative to
  // each other (its medium-long stays the biggest), placed so the biggest is furthest from the long run.
  const fixed = out.reduce((s, x) => s + (x?.kind === "race" ? 0 : x?.km ?? 0), 0);
  const longSlot = out.findIndex((x) => x?.kind === "long");
  const slots = WEEK_KEYS.map((_k, i) => i).filter((i) => !out[i] && run.has(WEEK_KEYS[i]));
  const gap = (i: number) => (longSlot < 0 ? 3 : Math.min(Math.abs(i - longSlot), 7 - Math.abs(i - longSlot)));
  const nextToKey = (i: number) => out[i - 1]?.kind === "key" || out[i + 1]?.kind === "key";
  const order = [...slots].sort((x, y) => gap(y) - gap(x) || Number(nextToKey(x)) - Number(nextToKey(y)) || x - y);
  const sizes = easy.map((x) => x.d.km ?? 0).sort((x, y) => y - x);
  const smallest = sizes.length ? sizes[sizes.length - 1] : 8;
  // Same days as the plan: each easy run keeps its own size and place. New days: sizes handed out by distance from the long run.
  const sameDays = !a.runDays && !a.longDay;
  const weight = new Map(order.map((i, n) => [i, sameDays && (days[i].km ?? 0) > 0 && i !== longI ? days[i].km! : sizes[n] ?? smallest]));
  const biggest = sizes[0] ?? 0;
  const nextToLong = Math.max(0, ...easy.filter((x) => longI >= 0 && Math.abs(x.i - longI) === 1).map((x) => x.d.km ?? 0));
  const capFor = (i: number) => Math.round(longSlot >= 0 && Math.abs(i - longSlot) === 1 ? Math.max(12, nextToLong * a.volume) : Math.max(22, biggest * a.volume));
  const left = Math.max(0, target - fixed);
  const wsum = slots.reduce((s, i) => s + (weight.get(i) ?? 8), 0) || 1;
  const hadMedium = easy.some((x) => /medium/i.test(x.d.text) || (x.d.km ?? 0) >= 16);
  let strides = easy.some((x) => /strides/i.test(x.d.text));
  for (const i of order) {
    const k = clamp(Math.round((left * (weight.get(i) ?? 8)) / wsum), 5, capFor(i));
    const recovery = longSlot >= 0 && i === longSlot + 1;
    const medium = hadMedium && (sameDays ? /medium/i.test(days[i].text) : i === order[0]) && k >= 16;
    let text = `${k} km ${recovery ? "recovery" : medium ? "medium-long" : "easy"}`;
    if (strides && !recovery && !medium && gap(i) > 1) {
      text += " + 6 × 20 s strides";
      strides = false;
    }
    out[i] = { text, km: k, kind: "easy" };
  }

  const sessions: PlanWeek["sessions"] = {};
  WEEK_KEYS.forEach((k, i) => {
    const x = out[i];
    if (x?.kind === "race") {
      // Leave race days to the plan (the race itself comes from the races list).
      if (week.sessions[k]) sessions[k] = week.sessions[k];
    } else sessions[k] = x ? x.text : "Rest";
  });
  const km = out.reduce((s, x) => s + (x?.km ?? 0), 0);
  const label = /\+\s*race/i.test(week.km) ? `about ${Math.round(km - raceKm)} + race` : String(Math.round(km));
  return { ...week, sessions, km: label, kmMin: Math.round(km - (/\+\s*race/i.test(week.km) ? raceKm : 0)), kmMax: Math.round(km - (/\+\s*race/i.test(week.km) ? raceKm : 0)) };
}

/** The plan with your settings applied. `baseWeeks` keeps the plan as written, for editing. */
export function applyAdjust(plan: Plan): Plan {
  const a = plan.adjust;
  if (!a) return plan;
  // Days written out first, so every day has a session to move or resize.
  const full: Plan = { ...plan, weeks: plan.weeks.map((w) => (w.start >= a.from ? { ...w, sessions: fullWeekSessions(plan, w) } : w)) };
  return { ...plan, baseWeeks: plan.weeks, weeks: full.weeks.map((w) => adjustWeek(full, w, a)) };
}

/** Summary of a stretch of the plan, for the before/after preview. */
export function planStats(plan: Plan, from: string, to: string) {
  const weeks: { monday: string; km: number; long: number; runs: number }[] = [];
  for (const w of plan.weeks.filter((x) => x.start >= from && x.start <= to)) {
    const f = forecastWeek(plan, w.start);
    const runs = f.days.filter((d: ForecastDay) => (d.km ?? 0) > 0);
    const training = runs.filter((d) => !d.race && d.kind !== "race");
    weeks.push({ monday: w.start, km: f.plannedKm ?? 0, long: Math.max(0, ...training.map((d) => d.km ?? 0)), runs: runs.length });
  }
  const peak = Math.max(0, ...weeks.map((w) => w.km));
  const longest = Math.max(0, ...weeks.map((w) => w.long));
  const total = weeks.reduce((s, w) => s + w.km, 0);
  return { weeks, peak, longest, total, avgRuns: weeks.length ? weeks.reduce((s, w) => s + w.runs, 0) / weeks.length : 0 };
}

export const nextMonday = (today: string) => addDays(today, 7 - ((new Date(today + "T12:00").getDay() + 6) % 7));
