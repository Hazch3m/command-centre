import { addDays } from "../../core/time";
import { forecastWeek, fullWeekSessions, sessionKm, type ForecastDay } from "./forecast";
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
  /** Stepping the plan up from a Monday, after good weeks or a plateau (you chose it). */
  progress?: Progress | null;
}
export interface Progress {
  from: string;
  /** A second speed session (threshold reps) on an easy day. */
  extraSession?: boolean;
  /** One more running day: an easy run on a rest day. */
  extraDay?: boolean;
  /** Doubles a week: a short easy second run. */
  doubles?: number;
  /** Norwegian double threshold: one key day becomes two controlled threshold sessions. */
  doubleThreshold?: boolean;
}
export const PROGRESS_LABEL = (p: Progress) =>
  [p.extraSession && "a second speed session", p.extraDay && "an extra running day", p.doubles && `${p.doubles} double${p.doubles > 1 ? "s" : ""} a week`, p.doubleThreshold && "Norwegian double threshold"].filter(Boolean).join(", ");
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
  if (!c || (!c.weeks && !c.recovery && !c.pace?.shift && !c.progress)) return plan;
  const tPace = /(\d:\d{2})\s*[–-]\s*(\d:\d{2})/.exec(plan.paces.find((p) => /^Threshold/i.test(p.zone))?.now ?? "");
  const tRange = tPace ? `${tPace[1]}–${tPace[2]}` : null;
  const rec = c.recovery;
  const recEnd = rec ? (rec.weeks ? addDays(rec.from, rec.weeks * 7) : "9999-12-31") : "";
  const weeks = plan.weeks.map((w) => {
    const mode = c.weeks?.[w.start];
    const inRec = !!rec && w.start >= rec.from && w.start < recEnd;
    const shift = c.pace?.shift && w.end >= c.pace.from ? c.pace.shift : 0;
    const prog = c.progress && w.start >= c.progress.from && !/taper|race/i.test(w.phase) && !inRec && !mode ? c.progress : null;
    if (!mode && !inRec && !shift && !prog) return w;
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
    if (prog) notes = stepUp(days, s, prog, tRange, /^Easier week/i.test(w.notes ?? ""), +w.week || 0) ?? notes;
    if (shift) for (const k of WEEK_KEYS) if (s[k]) s[k] = shiftPaces(s[k]!, shift);
    const km = prog ? WEEK_KEYS.reduce((a, k) => a + (sessionKm(s[k] ?? "") ?? 0), 0) : WEEK_KEYS.reduce((a, k) => a + (+(/^(\d+(?:\.\d+)?)\s*km/.exec(s[k] ?? "")?.[1] ?? 0) || 0), 0);
    const changedKm = inRec || mode || prog;
    return { ...w, sessions: s, notes, ...(changedKm ? { km: String(Math.round(km)), kmMin: Math.round(km), kmMax: Math.round(km) } : {}) };
  });
  const paces = c.pace?.shift ? plan.paces.map((p) => ({ ...p, now: shiftPaces(p.now, c.pace!.shift) })) : plan.paces;
  return { ...plan, weeks, paces };
}

/**
 * Steps a week up: a second speed session, an extra easy day, doubles, or a Norwegian double
 * threshold day. Hard days stay apart (nothing hard next to the long run or another session),
 * easier weeks get at most one double and no extra session, race weeks are left alone.
 */
function stepUp(days: ForecastDay[], s: PlanWeek["sessions"], p: Progress, t: string | null, cut: boolean, weekNo: number): string | null {
  if (days.some((d) => d.race || d.kind === "race")) return null;
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 7 - Math.abs(a - b));
  const hard = () => days.map((d, i) => (d.kind === "long" || d.kind === "key" || /Threshold:|× .* at /.test(s[WEEK_KEYS[i]] ?? "") ? i : -1)).filter((i) => i >= 0);
  const longI = days.findIndex((d) => d.kind === "long");
  const isRun = (i: number) => (sessionKm(s[WEEK_KEYS[i]] ?? "") ?? 0) > 0;
  const easyKm = days.filter((d) => d.kind === "easy" && runDay(d)).map(kmOf);
  const avgEasy = easyKm.length ? easyKm.reduce((a, b) => a + b, 0) / easyKm.length : 8;
  const added: string[] = [];
  const far = (i: number, min: number) => hard().every((h) => h === i || gap(h, i) >= min);
  if (p.extraDay) {
    const rest = days.map((_, i) => i).filter((i) => !isRun(i) && !/cross/i.test(s[WEEK_KEYS[i]] ?? ""));
    const pick = rest.sort((a, b) => Math.min(...hard().map((h) => gap(h, b)), 9) - Math.min(...hard().map((h) => gap(h, a)), 9))[0];
    if (pick != null) {
      s[WEEK_KEYS[pick]] = `${Math.max(5, Math.min(10, Math.round(avgEasy * 0.8)))} km easy`;
      added.push("an extra easy day");
    }
  }
  if (p.extraSession && !cut && t) {
    const cands = days.map((_, i) => i).filter((i) => days[i].kind === "easy" && isRun(i) && !/PM:/.test(s[WEEK_KEYS[i]] ?? ""));
    const pick = cands.find((i) => far(i, 2)) ?? null;
    if (pick != null) {
      const reps = weekNo % 2 ? "5 × 1 km" : "3 × 2 km";
      const k = Math.max(10, Math.round(kmOf(days[pick]) || avgEasy));
      s[WEEK_KEYS[pick]] = `${k} km with 3 km warm-up, Threshold: ${reps} at ${t}, 60 s jog, 2 km cool-down`;
      added.push("a second session");
    }
  }
  if (p.doubleThreshold && !cut && t) {
    const k = days.findIndex((d) => d.kind === "key");
    if (k >= 0) {
      const slow = shiftPaces(t, 5);
      s[WEEK_KEYS[k]] = `14 km with 3 km warm-up, Threshold: 4 × 2 km at ${slow}, 60 s jog, 2 km cool-down · PM: 10 km with 2 km warm-up, Threshold: 6 × 1 km at ${t}, 60 s jog, 1 km cool-down`;
      added.push("double threshold");
    }
  }
  const nD = p.doubles ? (cut ? Math.min(1, p.doubles) : p.doubles) : 0;
  if (nD > 0) {
    const cands = days
      .map((_, i) => i)
      .filter((i) => days[i].kind === "easy" && isRun(i) && !/PM:|Threshold:/.test(s[WEEK_KEYS[i]] ?? "") && (longI < 0 || gap(i, longI) >= 2));
    for (const i of cands.slice(0, nD)) s[WEEK_KEYS[i]] = `${s[WEEK_KEYS[i]]} · PM: 6 km easy`;
    if (cands.length) added.push(`${Math.min(nD, cands.length)} double${Math.min(nD, cands.length) > 1 ? "s" : ""}`);
  }
  return added.length ? `Stepped up (you chose it): ${added.join(", ")}. Keep the easy runs easy.` : null;
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
export function planAdvice(plan: Plan, runs: Run[], checks: { day: ForecastDay; check: PaceCheck }[], today: string, overrides?: Map<string, string>, fit?: { slope: number | null; level?: string }): Advice[] {
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
  // Going well, or stuck: offer a step up (a second session, a day, doubles, double threshold).
  const phaseNow = plan.weeks.find((w) => w.start <= today && w.end >= today)?.phase ?? "";
  const prog = plan.changes?.progress ?? null;
  const steady = ratio != null && ratio >= 0.9 && planned >= 20 && missed === 0 && !(key.length >= 3 && median >= 4);
  if (steady && !/taper|race/i.test(phaseNow)) {
    const slope = fit?.slope ?? null;
    const plateau = slope != null && slope < 0.05;
    const flying = (slope != null && slope >= 0.15) || (key.length >= 3 && median <= -3);
    if (plateau || flying) {
      const wk = forecastWeek(plan, thisMon, runs, overrides);
      const days = wk.days.filter(runDay).length;
      const keys = wk.days.filter((d) => d.kind === "key").length;
      const avgKm = actual / Math.max(1, weeks.length);
      const level = fit?.level ?? (avgKm >= 80 ? "advanced" : avgKm >= 40 ? "intermediate" : "beginner");
      const base: Progress = { ...(prog ?? {}), from: prog?.from ?? nextMon };
      const actions: Advice["actions"] = [];
      if (keys < 2 && days >= 4 && !prog?.extraSession) actions.push({ label: "Add a second speed session", change: { progress: { ...base, extraSession: true } } });
      if (days < 6 && !prog?.extraDay) actions.push({ label: "Add a running day", change: { progress: { ...base, extraDay: true } } });
      if (days >= 6 && level !== "beginner" && avgKm >= 80 && !prog?.doubles) actions.push({ label: "Add 2 doubles a week", change: { progress: { ...base, doubles: 2 } } });
      if ((level === "advanced" || level === "elite") && avgKm >= 90 && days >= 6 && keys >= 1 && !prog?.doubleThreshold) actions.push({ label: "Try Norwegian double threshold", change: { progress: { ...base, doubleThreshold: true } } });
      if (actions.length)
        out.push({
          id: `stepup-${tag}`,
          tone: "good",
          title: plateau ? "Your fitness has levelled off" : "You're handling the plan well",
          text:
            (plateau
              ? `You've run ${Math.round(ratio! * 100)}% of the plan with no sessions missed, but your VO2 max has barely moved over the last eight weeks. A bit more stimulus usually gets it moving again.`
              : `${Math.round(ratio! * 100)}% of the plan, no sessions missed${key.length >= 3 && median <= -3 ? ", sessions quicker than the targets" : ""}, and your fitness is climbing. If you feel fresh, you can take on a little more.`) +
            " Pick one at most; it starts next Monday and is easy to undo. A second session adds the most; an extra day or doubles add easy volume; double threshold (two controlled threshold sessions in a day) is for high-mileage runners who recover well.",
          actions: actions.slice(0, 3),
        });
    }
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
