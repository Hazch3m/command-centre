import { addDays } from "../../core/time";
import type { HealthDay } from "../health/data";
import type { ForecastDay, ForecastWeek } from "./forecast";
import type { PaceCheck } from "./pace";

/**
 * The coach: plain verdicts with one thing to do about each. Are you on track for the goal, how the
 * week is going line by line, what to do today given how you've recovered, and what a run meant.
 * Pure functions over what the app already knows (plan, runs, pace checks, health), so they can be
 * tested and shown anywhere.
 */
export type Tone = "good" | "warn" | "bad" | "info";
export interface CoachLine {
  tone: Tone;
  label: string;
  detail: string;
  /** The one thing to do about it. */
  fix?: string;
}

const DAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const dayName = (date: string) => DAY[(new Date(date + "T12:00:00").getDay() + 6) % 7];
const isRun = (d: ForecastDay) => (d.km ?? 0) > 0 && d.kind !== "rest" && !/^rest\b/i.test(d.text);
const pace = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
export const clock = (s: number) => {
  const r = Math.round(s);
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r % 60).padStart(2, "0")}` : `${m}:${String(r % 60).padStart(2, "0")}`;
};

// ---- Recovery -------------------------------------------------------------------------------

export interface Recovery {
  level: "good" | "caution" | "poor" | "unknown";
  reasons: string[];
}

/** How recovered you are today, from sleep, HRV against your baseline, resting heart rate and Garmin's readiness. */
export function recoveryOf(health: HealthDay[], today: string): Recovery {
  const rows = health.filter((h) => h.date <= today && h.date >= addDays(today, -28)).sort((a, b) => a.date.localeCompare(b.date));
  const recent = rows.filter((h) => h.date >= addDays(today, -2));
  if (!recent.some((h) => h.hrv != null || h.rhr != null || h.sleep_secs != null || h.readiness != null)) return { level: "unknown", reasons: [] };
  const reasons: string[] = [];
  let flags = 0;

  // HRV: under your baseline's low edge (or well under your own average) on two of the last three days.
  const older = rows.filter((h) => h.date < addDays(today, -2) && h.hrv != null).map((h) => h.hrv!);
  const mean = older.length >= 5 ? older.reduce((a, b) => a + b, 0) / older.length : null;
  const low = recent.filter((h) => h.hrv != null && (h.hrv_low != null ? h.hrv < h.hrv_low : mean != null && h.hrv < mean * 0.88));
  if (low.length >= 2) {
    flags += 1;
    reasons.push(`HRV below your baseline for ${low.length} of the last 3 days`);
  }
  // Resting heart rate: 5 or more above your usual.
  const rhrOld = rows.filter((h) => h.date < addDays(today, -1) && h.rhr != null).map((h) => h.rhr!);
  const rhrMean = rhrOld.length >= 5 ? rhrOld.reduce((a, b) => a + b, 0) / rhrOld.length : null;
  const rhrNow = [...recent].reverse().find((h) => h.rhr != null)?.rhr ?? null;
  if (rhrMean != null && rhrNow != null && rhrNow - rhrMean >= 5) {
    flags += 1;
    reasons.push(`resting heart rate ${Math.round(rhrNow - rhrMean)} bpm above your usual`);
  }
  // Sleep: a short night, or three in a row on the short side.
  const last = [...recent].reverse().find((h) => h.sleep_secs != null)?.sleep_secs ?? null;
  const nights = recent.filter((h) => h.sleep_secs != null).map((h) => h.sleep_secs!);
  if (last != null && last < 6 * 3600) {
    flags += 1;
    reasons.push(`only ${Math.floor(last / 3600)}:${String(Math.round((last % 3600) / 60)).padStart(2, "0")} of sleep last night`);
  } else if (nights.length >= 3 && nights.reduce((a, b) => a + b, 0) / nights.length < 6.5 * 3600) {
    flags += 1;
    reasons.push("three short nights in a row");
  }
  const ready = [...recent].reverse().find((h) => h.readiness != null)?.readiness ?? null;
  if (ready != null && ready < 35) {
    flags += 1;
    reasons.push(`Garmin readiness ${ready}`);
  }
  return { level: flags >= 2 ? "poor" : flags === 1 ? "caution" : "good", reasons };
}

// ---- The week, line by line ------------------------------------------------------------------

const POINTS: Record<Tone, number | null> = { good: 100, warn: 65, bad: 30, info: null };

/**
 * How a week went (or is going): runs done, mileage, sessions on pace, easy kept easy, the long run.
 * `today` bounds "so far"; pass a date after the week for a finished week.
 */
export function weekLines(fw: ForecastWeek, checks: PaceCheck[], today: string): { score: number | null; lines: CoachLine[] } {
  const lines: CoachLine[] = [];
  const due = fw.days.filter((d) => isRun(d) && !d.race && (d.date < today || d.runs.length > 0));
  const missed = due.filter((d) => !d.runs.length);
  const over = fw.days[6].date < today;
  if (due.length) {
    lines.push({
      tone: missed.length === 0 ? "good" : missed.length === 1 ? "warn" : "bad",
      label: "Runs",
      detail: `${due.length - missed.length} of ${due.length} ${over ? "" : "so far"}`.trim(),
      fix: missed.length ? `Missed ${missed.map((d) => dayName(d.date)).join(" and ")}: don't cram it in, carry on with the plan.` : undefined,
    });
    const planned = due.reduce((s, d) => s + (d.km ?? 0), 0);
    const ran = fw.days.filter((d) => d.date <= today).reduce((s, d) => s + d.actualKm, 0);
    const ratio = planned > 0 ? ran / planned : 1;
    lines.push({
      tone: ratio > 1.2 ? "warn" : ratio >= 0.9 ? "good" : ratio >= 0.7 ? "warn" : "bad",
      label: "Mileage",
      detail: `${Math.round(ran)} of ${Math.round(planned)} km ${over ? "" : "so far"}`.trim(),
      fix: ratio > 1.2 ? "More than planned: extra kilometres raise injury risk faster than fitness." : ratio < 0.7 ? "Well under the plan: if this keeps up, lower the plan's mileage rather than chasing it." : undefined,
    });
  }
  const inWeek = checks.filter((c) => c.date >= fw.monday && c.date <= fw.days[6].date && !c.autoZone);
  const sessions = inWeek.filter((c) => c.session);
  if (sessions.length) {
    const off = sessions.filter((c) => c.verdict !== "on-point");
    const worst = [...off].sort((a, b) => Math.abs(b.off) - Math.abs(a.off))[0];
    lines.push({
      tone: off.length === 0 ? "good" : off.some((c) => c.verdict.startsWith("too")) ? "bad" : "warn",
      label: "Sessions on pace",
      detail: `${sessions.length - off.length} of ${sessions.length} on target`,
      fix: worst ? `${dayName(worst.date)}'s session was ${Math.abs(Math.round(worst.off))} ${worst.unit === "bpm" ? "bpm" : "s/km"} too ${worst.off < 0 ? "fast: hold the target, the pace is the point" : "slow: fine once, but if it repeats, ease the paces"}.` : undefined,
    });
  }
  const easy = inWeek.filter((c) => !c.session);
  if (easy.length) {
    const fast = easy.filter((c) => c.off < 0);
    const by = fast.length ? Math.round(fast.reduce((s, c) => s - c.off, 0) / fast.length) : 0;
    lines.push({
      tone: fast.length === 0 ? "good" : by >= 10 || fast.length > 1 ? "bad" : "warn",
      label: "Easy kept easy",
      detail: fast.length === 0 ? `${easy.length} of ${easy.length}` : `${fast.length} of ${easy.length} too fast`,
      fix: fast.length ? `Easy runs ${by} s/km quicker than easy: slow the next one down so the sessions stay sharp.` : undefined,
    });
  }
  const long = fw.days.find((d) => d.kind === "long" && isRun(d));
  if (long && (long.date < today || long.runs.length)) {
    const short = long.runs.length ? (long.km ?? 0) - long.actualKm : null;
    lines.push({
      tone: short == null ? "bad" : short > Math.max(2, (long.km ?? 0) * 0.15) ? "warn" : "good",
      label: "Long run",
      detail: short == null ? "missed" : `${long.actualKm.toFixed(0)} of ${long.km} km`,
      fix: short == null ? "The long run is the week's most important run for a marathon: protect it next week." : short > Math.max(2, (long.km ?? 0) * 0.15) ? `${Math.round(short)} km short: keep next week's as planned rather than adding it on.` : undefined,
    });
  }
  const pts = lines.map((l) => POINTS[l.tone]).filter((p): p is number => p != null);
  return { score: pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : null, lines };
}

// ---- On track for the goal? ------------------------------------------------------------------

/** "2:48–2:52", "Sub-2:45", "1:25", "19:30" → the goal as seconds (the slow end of a range). */
export function goalSeconds(target: string | null | undefined, km: number): number | null {
  const times = [...(target ?? "").matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g)].map((m) => {
    const [a, b, c] = [Number(m[1]), Number(m[2]), m[3] == null ? null : Number(m[3])];
    return c != null ? a * 3600 + b * 60 + c : km >= 21 ? a * 3600 + b * 60 : a * 60 + b;
  });
  return times.length ? Math.max(...times) : null;
}

export interface TrackInput {
  raceName: string;
  km: number;
  target: string | null | undefined;
  daysTo: number;
  /** The prediction for this distance now, and about a month ago. */
  now: number | null;
  monthAgo: number | null;
  /** Share of the planned mileage run over the last three weeks (null before the plan). */
  completion: number | null;
}
export interface Track {
  tone: Tone;
  verdict: "Ahead of goal" | "On track" | "Slightly behind" | "Behind" | "No goal time yet" | "Not enough data yet";
  detail: string;
  fix?: string;
}

/** Where the prediction stands against the goal, and where it's heading by race day. */
export function trackOf(t: TrackInput): Track {
  const goal = goalSeconds(t.target, t.km);
  if (t.now == null) return { tone: "info", verdict: "Not enough data yet", detail: `A few more runs and there'll be a prediction for ${t.raceName}.` };
  if (goal == null) return { tone: "info", verdict: "No goal time yet", detail: `Predicted ${clock(t.now)} for ${t.raceName} today. Add a goal time to the race to be judged against it.` };
  const perMonth = t.monthAgo != null ? t.monthAgo - t.now : 0; // + = getting faster
  const months = Math.max(0, t.daysTo - 14) / 30; // the last two weeks are taper, not gains
  // Gains slow down: count the recent rate at half strength, and at most 4% of the time.
  const heading = Math.max(t.now - Math.min(Math.max(0, perMonth) * months * 0.5, t.now * 0.04), 0);
  const gap = t.now - goal;
  const trend = perMonth >= 20 ? ` and getting ${clock(perMonth)} faster a month` : perMonth <= -20 ? ` and ${clock(-perMonth)} slower than a month ago` : "";
  const base = `Predicted ${clock(t.now)} today${trend}; the goal is ${t.target}.`;
  if (gap <= -goal * 0.01) return { tone: "good", verdict: "Ahead of goal", detail: base, fix: "Keep doing what you're doing; no need to add anything." };
  if (gap <= 0) return { tone: "good", verdict: "On track", detail: base };
  if (heading <= goal) return { tone: "good", verdict: "On track", detail: `${base} At this rate you reach it by race day.` };
  const low = t.completion != null && t.completion < 0.8;
  const fix = low
    ? `You've run ${Math.round(t.completion! * 100)}% of the planned mileage in the last three weeks: consistency is the biggest lever.`
    : perMonth <= 0
      ? "Fitness has stalled: check the easy runs are easy and the sessions hit their paces."
      : t.daysTo < 42
        ? "Little time left to gain fitness: consider a goal a touch slower and race it well."
        : "Keep stacking weeks; the long runs and threshold work move this most.";
  return gap <= goal * 0.03 ? { tone: "warn", verdict: "Slightly behind", detail: `${base} ${clock(gap)} to find.`, fix } : { tone: "bad", verdict: "Behind", detail: `${base} ${clock(gap)} to find.`, fix };
}

// ---- Today -----------------------------------------------------------------------------------

export interface TodayAdvice {
  tone: Tone;
  headline: string;
  detail: string;
  /** Swap today's session with this later easy day. */
  swapWith?: ForecastDay;
}

/** What to do today: the session as planned, or changed for how you've recovered. */
export function todayAdvice(fw: ForecastWeek, today: string, rec: Recovery, title: (d: ForecastDay) => string): TodayAdvice {
  const d = fw.days.find((x) => x.date === today);
  const why = rec.reasons.length ? rec.reasons.join(", ") : "";
  const Why = why.charAt(0).toUpperCase() + why.slice(1);
  if (!d) return { tone: "info", headline: "Nothing planned", detail: "No plan for today." };
  if (d.runs.length) return { tone: "good", headline: `Done: ${d.actualKm.toFixed(1)} km`, detail: rec.level === "poor" ? `${Why}: make tonight an early one.` : "Today's run is in the bank." };
  if (d.race) return { tone: "info", headline: `Race day: ${d.race.name}`, detail: "Trust the training. Start at goal pace, not faster." };
  if (!isRun(d)) return { tone: rec.level === "poor" ? "warn" : "good", headline: "Rest day", detail: rec.level === "poor" ? `${Why}: a good day for it.` : "Recovery is where the training turns into fitness." };
  const hard = d.kind === "key" || d.kind === "long";
  const what = `${title(d)}, ${d.km} km`;
  if (rec.level === "poor" && hard) {
    const swapWith = fw.days.find((x) => x.date > today && isRun(x) && x.kind === "easy" && !x.runs.length && !x.race);
    return {
      tone: "bad",
      headline: swapWith ? `Move today's session to ${dayName(swapWith.date)}` : "Turn today into an easy run",
      detail: `${Why}. A hard session on a tired body costs more than it gives${swapWith ? `: run ${dayName(swapWith.date)}'s easy ${swapWith.km} km today instead` : ": jog it easy and pick the plan up tomorrow"}.`,
      swapWith,
    };
  }
  if (rec.level === "poor") return { tone: "warn", headline: "Keep it very easy, or rest", detail: `${Why}. Shorten today's ${d.km} km if it feels like work.` };
  if (rec.level === "caution" && hard) return { tone: "warn", headline: `Go, but by feel: ${what}`, detail: `${Why}. If the first rep feels harder than it should, turn the rest into easy running.` };
  if (rec.level === "caution") return { tone: "good", headline: `Go: ${what}`, detail: `${Why}: keep it properly easy.` };
  return { tone: "good", headline: `Go: ${what}`, detail: rec.level === "good" ? "You're recovered: run it as planned." : "Run it as planned." };
}

// ---- One run ---------------------------------------------------------------------------------

/** What a run meant: did it do the job the plan gave it, and what to take from it. */
export function runVerdict(day: ForecastDay | null, check: PaceCheck | null, ranKm: number): CoachLine | null {
  if (!day || !isRun(day)) return null;
  const planned = day.km ?? 0;
  const diff = ranKm - planned;
  const dist = planned > 0 && Math.abs(diff) > Math.max(1.5, planned * 0.12) ? (diff < 0 ? ` ${Math.abs(diff).toFixed(0)} km shorter than planned.` : ` ${diff.toFixed(0)} km more than planned: the extra isn't needed.`) : "";
  if (!check) return dist ? { tone: "info", label: "Distance", detail: dist.trim() } : null;
  const unit = check.unit === "bpm" ? "bpm" : "s/km";
  const range = check.unit === "bpm" ? `${Math.round(check.target[0])}–${Math.round(check.target[1])} bpm` : `${pace(check.target[0])}–${pace(check.target[1])}/km`;
  const did = check.unit === "bpm" ? `${Math.round(check.actual)} bpm` : `${pace(check.actual)}/km`;
  const by = Math.abs(Math.round(check.off));
  if (check.session) {
    const reps = check.inRange != null ? `, ${Math.round(check.inRange * 100)}% of the work in range` : "";
    if (check.verdict === "on-point") return { tone: "good", label: "Session on target", detail: `Averaged ${did} against ${range}${reps}.${dist}`, fix: "Exactly the job. Recover well; the next session builds on this one." };
    if (check.off < 0)
      return { tone: check.verdict === "too-fast" ? "bad" : "warn", label: `${by} ${unit} too quick`, detail: `Averaged ${did} against ${range}${reps}.${dist}`, fix: "The session works at its target pace; quicker adds fatigue, not fitness. If it felt easy, your paces may be due an update (Plan check)." };
    return { tone: check.verdict === "too-slow" ? "bad" : "warn", label: `${by} ${unit} off the target`, detail: `Averaged ${did} against ${range}${reps}.${dist}`, fix: "Fine if it was heat, hills or tired legs. If the next one's the same, ease the paces rather than forcing them." };
  }
  if (check.off < 0) return { tone: by >= 10 ? "bad" : "warn", label: "Faster than easy", detail: `${did} against an easy range of ${range}.${dist}`, fix: "Easy days are for recovery: slow down so the sessions stay sharp." };
  return { tone: "good", label: day.kind === "long" ? "Long run done right" : "Easy kept easy", detail: `${did}, inside ${range}.${dist}`, fix: day.kind === "long" ? "Eat and sleep well today; this is the run that builds the marathon." : undefined };
}
