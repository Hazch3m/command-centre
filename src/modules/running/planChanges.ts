import { addDays } from "../../core/time";
import { forecastWeek, fullWeekSessions, type ForecastDay } from "./forecast";
import { mondayOf, WEEK_KEYS, type Plan, type PlanWeek } from "./plan";
import type { Run } from "./strava";
import type { PaceCheck } from "./pace";

/**
 * Changes you make while following the plan, like Runna's: an easier or a rest
 * week when life gets in the way, recovery mode when injured or ill, and pace
 * targets nudged up or down. Kept apart from the plan (as `changes` in the plan
 * file), applied when it loads, and undone with a tap.
 */
export interface PlanChanges {
  /** Weeks you changed, by Monday. */
  weeks?: Record<string, "easier" | "rest">;
  /** Injured or ill: from a Monday, for some weeks (null: until you end it). */
  recovery?: RecoveryMode | null;
  /** Seconds per km added to the pace targets from a date (negative: faster). */
  pace?: { shift: number; from: string } | null;
  /** Suggestions you've dismissed. */
  dismissed?: string[];
}
export interface RecoveryMode {
  from: string;
  weeks: number | null;
  /** rest: no running; cross: cross-training instead; return: easy running, building back up. */
  mode: "rest" | "cross" | "return";
}
export const RECOVERY_LABEL: Record<RecoveryMode["mode"], string> = {
  rest: "Complete rest",
  cross: "Cross-train, no running",
  return: "Easy running, building back",
};

const fmtPace = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** Every "m:ss" pace in a session moved by `by` seconds ("4:02–4:06" → "4:05–4:09"). */
export function shiftPaces(text: string, by: number): string {
  if (!by) return text;
  return text.replace(/\b(\d{1,2}):([0-5]\d)\b/g, (m, a: string, b: string) => {
    const s = +a * 60 + +b;
    // Only running paces (2:30–9:59 a km), never clock or race times.
    return s >= 150 && s < 600 ? fmtPace(s + by) : m;
  });
}

const kmOf = (d: ForecastDay) => d.km ?? 0;
const runDay = (d: ForecastDay) => kmOf(d) > 0 && !d.race && d.kind !== "race";

function easierWeek(days: ForecastDay[], s: PlanWeek["sessions"], share: number) {
  let strides = true;
  days.forEach((d, i) => {
    if (!runDay(d)) return;
    const k = Math.max(3, Math.round(kmOf(d) * share));
    const key = WEEK_KEYS[i];
    if (d.kind === "long") s[key] = `${k} km long run`;
    else {
      s[key] = `${k} km easy${d.kind === "key" && strides ? " + 6 × 20 s strides" : ""}`;
      if (d.kind === "key") strides = false;
    }
  });
}

/** The plan with your changes applied (loadPlan does this last). */
export function applyChanges(plan: Plan): Plan {
  const c = plan.changes;
  if (!c || (!c.weeks && !c.recovery && !c.pace?.shift)) return plan;
  const rec = c.recovery;
  const recEnd = rec ? (rec.weeks ? addDays(rec.from, rec.weeks * 7) : "9999-12-31") : "";
  const weeks = plan.weeks.map((w) => {
    const mode = c.weeks?.[w.start];
    const inRec = !!rec && w.start >= rec.from && w.start < recEnd;
    const shift = c.pace?.shift && w.end >= c.pace.from ? c.pace.shift : 0;
    if (!mode && !inRec && !shift) return w;
    const days = forecastWeek(plan, w.start).days;
    const s: PlanWeek["sessions"] = { ...fullWeekSessions(plan, w) };
    let notes = w.notes;
    if (inRec) {
      const j = Math.round((Date.parse(w.start) - Date.parse(rec!.from)) / (7 * 86400000));
      if (rec!.mode === "rest") {
        days.forEach((d, i) => runDay(d) && (s[WEEK_KEYS[i]] = "Rest"));
        notes = "Recovery: complete rest. Walk if it feels good; no running.";
      } else if (rec!.mode === "cross") {
        days.forEach((d, i) => runDay(d) && (s[WEEK_KEYS[i]] = d.kind === "key" || d.kind === "long" ? "Cross-train 40–60 min easy (bike, swim, elliptical), no running" : "Rest or 30 min easy cross-training"));
        notes = "Recovery: keep fit without running. Stop anything that hurts.";
      } else {
        // Back to running gently: every other run day, then more, all easy, no long runs to speak of.
        const total = rec!.weeks ?? 4;
        const share = Math.min(0.85, 0.35 + (0.5 * j) / Math.max(1, total - 1));
        let n = 0;
        days.forEach((d, i) => {
          if (!runDay(d)) return;
          const key = WEEK_KEYS[i];
          n++;
          if (j === 0 && n % 2 === 0) s[key] = "Rest";
          else s[key] = `${Math.max(3, Math.min(d.kind === "long" ? 14 : 10, Math.round(kmOf(d) * share)))} km easy`;
        });
        notes = `Recovery: easy running only (week ${j + 1}${rec!.weeks ? ` of ${rec!.weeks}` : ""}). Stop if it hurts; no sessions until you're back.`;
      }
    } else if (mode === "rest") {
      days.forEach((d, i) => runDay(d) && (s[WEEK_KEYS[i]] = "Rest"));
      notes = "Rest week (you chose it): no running. The plan picks up next week.";
    } else if (mode === "easier") {
      easierWeek(days, s, 0.65);
      notes = "Easier week (you chose it): shorter, all easy, strides once.";
    }
    if (shift) for (const k of WEEK_KEYS) if (s[k]) s[k] = shiftPaces(s[k]!, shift);
    const km = WEEK_KEYS.reduce((a, k) => a + (+(/^(\d+(?:\.\d+)?)\s*km/.exec(s[k] ?? "")?.[1] ?? 0) || 0), 0);
    const changedKm = inRec || mode;
    return { ...w, sessions: s, notes, ...(changedKm ? { km: String(Math.round(km)), kmMin: Math.round(km), kmMax: Math.round(km) } : {}) };
  });
  const paces = c.pace?.shift ? plan.paces.map((p) => ({ ...p, now: shiftPaces(p.now, c.pace!.shift) })) : plan.paces;
  return { ...plan, weeks, paces };
}

// ---- Plan check: should the plan change? -------------------------------------------------

export interface Advice {
  id: string;
  tone: "good" | "warn" | "info";
  title: string;
  text: string;
  actions: { label: string; change: Partial<PlanChanges> | { volume: number } }[];
}

/**
 * Looks at the last three weeks: how much of the planned mileage you ran, the
 * sessions you missed, and how your sessions' paces compared with the targets
 * (Pace on point). Suggests easing or speeding up the targets, less mileage or
 * an easier week, like Runna's adaptive plan.
 */
export function planAdvice(plan: Plan, runs: Run[], checks: { day: ForecastDay; check: PaceCheck }[], today: string, overrides?: Map<string, string>): Advice[] {
  const out: Advice[] = [];
  const thisMon = mondayOf(today);
  const nextMon = addDays(thisMon, 7);
  const weeks = [1, 2, 3].map((n) => forecastWeek(plan, addDays(thisMon, -7 * n), runs, overrides)).filter((w) => (w.plannedKm ?? 0) > 0);
  const planned = weeks.reduce((s, w) => s + (w.plannedKm ?? 0), 0);
  const actual = weeks.reduce((s, w) => s + w.actualKm, 0);
  const ratio = planned > 0 ? actual / planned : null;
  // Sessions in the last two weeks with no run that day.
  const recent = [0, 1, 2].map((n) => forecastWeek(plan, addDays(thisMon, -7 * n), runs, overrides)).flatMap((w) => w.days);
  const missed = recent.filter((d) => d.date < today && d.date >= addDays(today, -14) && d.kind === "key" && !d.runs.length && !d.race).length;
  const key = checks.filter((c) => c.check.date >= addDays(today, -21) && (c.day.kind === "key" || /\bat\b/.test(c.day.text)) && !c.check.autoZone && c.check.unit !== "bpm");
  const offs = key.map((c) => c.check.off).sort((a, b) => a - b);
  const median = offs.length ? offs[offs.length >> 1] : 0;
  const fastShare = key.length ? key.filter((c) => c.check.off < 0).length / key.length : 0;
  const slowShare = key.length ? key.filter((c) => c.check.off > 0).length / key.length : 0;
  const shift = plan.changes?.pace?.shift ?? 0;
  const tag = thisMon;

  if (key.length >= 3 && median <= -3 && fastShare >= 0.6) {
    const by = Math.min(8, Math.max(2, Math.round(-median * 0.6)));
    out.push({
      id: `pace-fast-${tag}`,
      tone: "good",
      title: "Your sessions are quicker than the targets",
      text: `${key.length} sessions in the last three weeks were about ${Math.round(-median)} s/km faster than planned. Your fitness has likely moved on: the targets can come down.`,
      actions: [{ label: `Make targets ${by} s/km faster`, change: { pace: { shift: shift - by, from: today } } }],
    });
  } else if (key.length >= 3 && median >= 4 && slowShare >= 0.6) {
    const by = Math.min(10, Math.max(3, Math.round(median * 0.6)));
    out.push({
      id: `pace-slow-${tag}`,
      tone: "warn",
      title: "Your sessions are slower than the targets",
      text: `${key.length} sessions in the last three weeks were about ${Math.round(median)} s/km slower than planned. Tired, hot, or the targets are a bit ambitious: easing them keeps the sessions doing their job.`,
      actions: [
        { label: `Ease targets by ${by} s/km`, change: { pace: { shift: shift + by, from: today } } },
        { label: "Make next week easier", change: { weeks: { ...(plan.changes?.weeks ?? {}), [nextMon]: "easier" } } },
      ],
    });
  }
  if (ratio != null && ratio < 0.75 && planned >= 15) {
    out.push({
      id: `volume-low-${tag}`,
      tone: "warn",
      title: `You've run ${Math.round(ratio * 100)}% of the planned mileage`,
      text: `${Math.round(actual)} of ${Math.round(planned)} km over the last ${weeks.length} weeks. Jumping straight back to the full plan is how injuries happen: bring the mileage down for now.`,
      actions: [
        { label: "Lower mileage to 85%", change: { volume: 0.85 } },
        { label: "Make next week easier", change: { weeks: { ...(plan.changes?.weeks ?? {}), [nextMon]: "easier" } } },
      ],
    });
  } else if (ratio != null && ratio > 1.2 && planned >= 30) {
    out.push({
      id: `volume-high-${tag}`,
      tone: "info",
      title: `You've run ${Math.round(ratio * 100)}% of the planned mileage`,
      text: "More than planned. Fine if it feels easy; if your legs are heavy, keep the easy days short so the sessions stay good.",
      actions: [],
    });
  }
  if (missed >= 2) {
    out.push({
      id: `missed-${tag}`,
      tone: "warn",
      title: `${missed} sessions missed in the last two weeks`,
      text: "Don't squeeze them in: carry on with the plan. If life is busy, an easier week now lets you start the next block fresh.",
      actions: [{ label: "Make this week easier", change: { weeks: { ...(plan.changes?.weeks ?? {}), [thisMon]: "easier" } } }],
    });
  }
  if (!out.length && ratio != null && ratio >= 0.85) {
    out.push({
      id: `ok-${tag}`,
      tone: "good",
      title: "On track",
      text: `${Math.round((ratio ?? 1) * 100)}% of the planned mileage over the last ${weeks.length} weeks${key.length ? `, and your sessions are close to their targets` : ""}. Keep going.`,
      actions: [],
    });
  }
  const dismissed = new Set(plan.changes?.dismissed ?? []);
  return out.filter((a) => !dismissed.has(a.id));
}
