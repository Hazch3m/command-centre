import { addDays, diffDays } from "../../core/time";
import { WEEK_KEYS, mondayOf, priorityOf, type Plan, type PlanWeek } from "./plan";
import { pacesFor } from "./planBuilder";
import type { Run, RunDetail } from "./strava";

/*
 * The Monday re-plan's other checks (spec v1.2, step 7), each a suggestion you confirm:
 *
 *  - Race pace: 2 weeks before a marathon's specific block starts, its goal pace is compared with your current
 *    prediction (marathon pace at your VDOT minus your endurance gap). If the goal is more than 4 s/km faster,
 *    the plan suggests the clipped pace: prediction − 4 s/km.
 *  - Fatigue flags, from whatever data there is:
 *      runs: easy-run efficiency (m per heartbeat, 135–150 bpm, flat runs) ≥ 4% below its 4-week median, two
 *            weeks running; key-session reps ≥ 5 bpm above the target heart rate at target pace, twice in 10 days
 *      Garmin daily data: resting HR ≥ 5 bpm above its 30-day median on 3 of the last 5 days; HRV status Low or
 *            Unbalanced on 4 of the last 7 days
 *    With 2 or more: a lighter next week (80%) and the next VO2 max session dropped. Today and past days never change.
 *  - Volume cap: held at 90% of the cap or more for 6 weeks with no fatigue flags: suggest raising it (+10 km,
 *    at most 1.3 × your best 4-week average).
 */

/** Endurance gap (VDOT points between your 5k/10k fitness and your marathon) when none is set: the spec's reference. */
export const DEFAULT_GAP = 2.9;

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const fmtP = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const isRun = (r: Run) => /run/i.test(r.sport);

// ---------------------------------------------------------------------------------------------------------------
// Race pace

export interface PaceSuggestion {
  race: string;
  date: string;
  /** Monday the specific block starts. */
  blockStart: string;
  /** Goal pace and the suggested (clipped) pace, s/km. */
  from: number;
  to: number;
  predicted: number;
}

const targetSecs = (t: string | undefined | null) => {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec((t ?? "").trim());
  if (!m) return null;
  return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
};

/** Marathons whose specific block starts in the next 2 weeks, with a goal more than 4 s/km faster than your prediction. */
export function racePaceCheck(plan: Plan, today: string, vdotNow: number | null, gap: number): PaceSuggestion[] {
  if (vdotNow == null) return [];
  const predicted = pacesFor(vdotNow - gap).mp;
  const out: PaceSuggestion[] = [];
  for (const ph of plan.phases) {
    if (!ph.start || !/-specific$/i.test(ph.name)) continue;
    if (!(today >= addDays(ph.start, -14) && today < ph.start)) continue;
    const race = plan.races
      .filter((r) => r.date && r.date > (ph.end ?? ph.start!) && priorityOf(r) === "A")
      .filter((r) => (r.km ?? 0) > 40 || (r.date === plan.built?.raceDate && plan.built?.dist === "marathon"))
      .sort((a, b) => a.date!.localeCompare(b.date!))[0];
    if (!race) continue;
    const t = targetSecs(race.target);
    const goal = race.planPace ?? (t ? t / 42.195 : null);
    if (goal == null) continue;
    if (goal < predicted - 4) out.push({ race: race.name, date: race.date!, blockStart: ph.start, from: goal, to: Math.round(predicted - 4), predicted });
  }
  return out;
}

/** The plan with the race's pace set (then re-planned by the caller). */
export function withRacePace(plan: Plan, s: PaceSuggestion): Plan {
  return { ...plan, races: plan.races.map((r) => (r.name === s.race && r.date === s.date ? { ...r, planPace: s.to } : r)) };
}
export const paceText = (s: PaceSuggestion) =>
  `${s.race}: your goal is ${fmtP(s.from)}/km, more than 4 s/km faster than your current marathon prediction (${fmtP(s.predicted)}/km). The specific block starting ${fmtDay(s.blockStart)} would use ${fmtP(s.to)}/km.`;

// ---------------------------------------------------------------------------------------------------------------
// Fatigue flags

export interface HealthRow {
  date: string;
  rhr: number | null;
  hrv_status: string | null;
}
export interface FatigueInput {
  plan: Plan;
  today: string;
  runs: Run[];
  details?: Map<string, RunDetail>;
  health?: HealthRow[];
}

/** Easy-run efficiency: metres per heartbeat on a flat easy run at 135–150 bpm (null for any other run). */
export function efficiency(r: Run): number | null {
  if (!isRun(r) || r.avg_hr == null || r.avg_hr < 135 || r.avg_hr > 150 || r.distance < 5000 || r.moving_time <= 0) return null;
  if (r.elevation / (r.distance / 1000) > 10) return null;
  return r.distance / (r.avg_hr * (r.moving_time / 60));
}

/** The session planned on a date (from the plan's weeks), or null. */
function plannedOn(plan: Plan, date: string): string | null {
  const w: PlanWeek | undefined = plan.weeks.find((x) => x.start === mondayOf(date));
  if (!w) return null;
  return w.sessions[WEEK_KEYS[diffDays(w.start, date)]] ?? null;
}

export function fatigueFlags(x: FatigueInput): string[] {
  const { plan, today, runs } = x;
  const flags: string[] = [];

  // Easy-run efficiency, two weeks running.
  const eff = runs.map((r) => ({ date: r.date, e: efficiency(r) })).filter((r): r is { date: string; e: number } => r.e != null && r.date <= today);
  const weekLow = (endIncl: string) => {
    const from = addDays(endIncl, -6);
    const wk = median(eff.filter((r) => r.date >= from && r.date <= endIncl).map((r) => r.e));
    const base = eff.filter((r) => r.date >= addDays(from, -28) && r.date < from).map((r) => r.e);
    const b = base.length >= 3 ? median(base) : null;
    return wk != null && b != null ? wk / b - 1 : null;
  };
  const e1 = weekLow(today);
  const e2 = weekLow(addDays(today, -7));
  if (e1 != null && e2 != null && e1 <= -0.04 && e2 <= -0.04)
    flags.push(`Easy runs are less efficient: ${Math.round(-e1 * 100)}% and ${Math.round(-e2 * 100)}% fewer metres per heartbeat than your 4-week median, two weeks running.`);

  // Key-session reps above their heart rate at target pace, twice in 10 days.
  const hr = plan.built?.hr;
  if (hr && x.details) {
    let hits = 0;
    for (let d = 0; d < 10; d++) {
      const date = addDays(today, -d);
      const text = plannedOn(plan, date);
      if (!text) continue;
      const cap = /Threshold/i.test(text) ? (hr.lthr ?? null) : /VO2 max|10K pace|5K pace/i.test(text) ? Math.round(hr.max * 0.97) : null;
      const pm = /at (\d+):(\d{2})(?:–(\d+):(\d{2}))?/.exec(text);
      if (!cap || !pm) continue;
      const lo = +pm[1] * 60 + +pm[2];
      const hi = pm[3] ? +pm[3] * 60 + +pm[4] : lo;
      const run = runs.filter((r) => r.date === date && isRun(r)).sort((a, b) => b.distance - a.distance)[0];
      const laps = (run && x.details.get(run.id)?.laps) || [];
      const reps = laps.filter((l) => l.hr && l.distance >= 300 && l.moving_time / (l.distance / 1000) >= lo - 3 && l.moving_time / (l.distance / 1000) <= hi + 3);
      if (reps.length < 2) continue;
      const avg = reps.reduce((a, l) => a + l.hr! * l.distance, 0) / reps.reduce((a, l) => a + l.distance, 0);
      if (avg >= cap + 5) hits++;
    }
    if (hits >= 2) flags.push(`Heart rate in your session reps was 5 bpm or more above target at target pace, ${hits} times in 10 days.`);
  }

  // Garmin daily data.
  const health = (x.health ?? []).filter((h) => h.date <= today);
  if (health.length) {
    const last5 = health.filter((h) => h.date > addDays(today, -5) && h.rhr != null);
    const base = median(health.filter((h) => h.date > addDays(today, -35) && h.date <= addDays(today, -5) && h.rhr != null).map((h) => h.rhr!));
    if (base != null) {
      const high = last5.filter((h) => h.rhr! >= base + 5).length;
      if (high >= 3) flags.push(`Resting heart rate is 5 bpm or more above its 30-day median (${Math.round(base)}) on ${high} of the last 5 days.`);
    }
    const last7 = health.filter((h) => h.date > addDays(today, -7) && h.hrv_status);
    const low = last7.filter((h) => /low|unbalanced|poor/i.test(h.hrv_status!)).length;
    if (low >= 4) flags.push(`HRV status was low or unbalanced on ${low} of the last 7 days.`);
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------------------------
// Lighter next week

const KM = /^(\d+(?:\.\d+)?) km/;
const isKey = (t: string) => / with \d+ km warm-up|Threshold|VO2 max|Marathon pace:|10K pace:|5K pace:|km steady at|progression run|fartlek/i.test(t);

export interface Lighter {
  plan: Plan;
  /** The VO2 max session dropped (now an easy run). */
  dropped: { date: string; text: string } | null;
  /** The lighter week: its km before and after. */
  week: { start: string; from: number; to: number } | null;
}

/** A lighter next week (easy runs and the long run at 80%) and the next VO2 max session (after today) as an easy run. */
export function lighterNextWeek(plan: Plan, today: string): Lighter {
  const next = addDays(mondayOf(today), 7);
  let dropped: Lighter["dropped"] = null;
  let week: Lighter["week"] = null;
  const weeks = plan.weeks.map((w) => {
    if (w.end <= today) return w;
    const sessions = { ...w.sessions };
    let changed = false;
    WEEK_KEYS.forEach((k, i) => {
      const date = addDays(w.start, i);
      const t = sessions[k];
      if (!t || date <= today) return;
      if (!dropped && /VO2 max:/.test(t)) {
        const km = Number(KM.exec(t)?.[1] ?? 8);
        sessions[k] = `${km} km easy`;
        dropped = { date, text: t };
        changed = true;
      }
    });
    if (w.start === next) {
      WEEK_KEYS.forEach((k) => {
        const t = sessions[k];
        const m = t && KM.exec(t);
        if (!t || !m || isKey(t)) return;
        sessions[k] = t.replace(KM, `${Math.max(4, Math.round(+m[1] * 0.8))} km`);
        changed = true;
      });
    }
    if (!changed) return w;
    const total = Object.values(sessions).reduce((a, t) => a + Number((t && KM.exec(t)?.[1]) ?? 0), 0);
    const out = { ...w, sessions, km: String(Math.round(total)), kmMin: Math.round(total), kmMax: Math.round(total), notes: [w.notes, w.start === next ? "Lighter week: fatigue flags in your data." : ""].filter(Boolean).join(" ") };
    if (w.start === next) week = { start: w.start, from: w.kmMin ?? total, to: Math.round(total) };
    return out;
  });
  return { plan: { ...plan, weeks, ...(plan.baseWeeks ? { baseWeeks: undefined } : {}) }, dropped, week };
}

// ---------------------------------------------------------------------------------------------------------------
// Volume cap

export interface CapSuggestion {
  from: number;
  to: number;
}

/** Held at 90% of the cap or more for the last 6 weeks, with no fatigue flags: a higher cap to suggest. */
export function capCheck(plan: Plan, today: string, weekKm: Map<string, number>, flags: number): CapSuggestion | null {
  const b = plan.built;
  if (!b || flags > 0) return null;
  const cap = b.tune?.peakKm ?? b.peak;
  if (!cap) return null;
  const secondary = plan.races.filter((r) => r.date && r.date < b.raceDate && priorityOf(r) === "A").map((r) => r.date!);
  const capFor = (m: string) => (secondary.some((d) => d >= m) ? 0.93 * cap : cap);
  const thisMonday = mondayOf(today);
  const weeks = Array.from({ length: 6 }, (_, k) => addDays(thisMonday, -7 * (k + 1)));
  if (!weeks.every((m) => weekKm.has(m) && weekKm.get(m)! >= 0.9 * capFor(m))) return null;
  // The best 4-week average in the last 12 weeks.
  let best = 0;
  for (let k = 0; k + 4 <= 12; k++) {
    const four = Array.from({ length: 4 }, (_, j) => weekKm.get(addDays(thisMonday, -7 * (k + j + 1))) ?? 0);
    best = Math.max(best, four.reduce((a, x) => a + x, 0) / 4);
  }
  const to = Math.min(cap + 10, Math.round(1.3 * best));
  return to > cap ? { from: cap, to } : null;
}

function fmtDay(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
