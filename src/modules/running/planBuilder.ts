import { addDays, diffDays } from "../../core/time";
import { targetTime } from "./fitness";
import { raceKm } from "./forecast";
import { mondayOf, priorityOf, WEEK_KEYS, type DayKey, type Plan, type PlanRace, type PlanWeek } from "./plan";
import { weeklyTotals } from "./stats";
import type { Run } from "./strava";
import { predictTime, vdot as vdotOf } from "./vo2";

/**
 * Builds a training plan from scratch, Runna-style: from your recent
 * training, the race, how long you have, a level and how many days a week
 * you'll run. The principles are the ones the hand-written plan follows
 * (Daniels' paces, Pfitzinger-style marathon blocks): mostly easy running,
 * gradual increases with easier weeks, a long run that grows slowly, two
 * quality sessions at most, race-specific work late, and a taper.
 */

export type RaceDist = "5k" | "10k" | "half" | "marathon";
export type Level = "beginner" | "intermediate" | "advanced" | "elite";

export const DIST_M: Record<RaceDist, number> = { "5k": 5000, "10k": 10000, half: 21097.5, marathon: 42195 };
export const DIST_LABEL: Record<RaceDist, string> = { "5k": "5k", "10k": "10k", half: "Half marathon", marathon: "Marathon" };

export interface BuildOptions {
  raceName: string;
  raceDate: string;
  dist: RaceDist;
  /** Goal time as typed ("2:45", "35:30"), or "". */
  target: string;
  weeks: number;
  level: Level;
  days: number;
  longDay: "sat" | "sun";
  /** Keep the other races in your plan that fall inside the new one, as tune-ups. */
  keepRaces: boolean;
  /** Your own tweaks on top of the level (unset: the level's own). */
  tune?: Tune;
  /** What the block is for: a race (the default), or getting faster, more mileage, base, or recovering. */
  goal?: Goal;
}

export type Goal = "race" | "faster" | "mileage" | "base" | "recover";
export const GOALS: { id: Goal; label: string; blurb: string; weeks: number }[] = [
  { id: "race", label: "A race", blurb: "Build to a race date, with a taper", weeks: 16 },
  { id: "faster", label: "Get faster", blurb: "Speed for 5k–half: intervals, threshold, then race pace; ends with a time trial", weeks: 10 },
  { id: "mileage", label: "More mileage", blurb: "Raise your weekly volume safely, mostly easy running", weeks: 10 },
  { id: "base", label: "Build base", blurb: "Aerobic base: easy miles, long runs, light fartlek and progression runs", weeks: 8 },
  { id: "recover", label: "Recover", blurb: "After a race or a break: easy running, coming back gradually", weeks: 3 },
];

export interface Tune {
  /** Biggest week, km. */
  peakKm?: number;
  /** First week, km. */
  startKm?: number;
  /** Longest long run, km. */
  longest?: number;
  /** Quality sessions a week (3 needs six days or more). */
  quality?: 1 | 2 | 3;
  /** An easier week every n weeks (0: none). */
  cutEvery?: 0 | 3 | 4 | 5;
  /** Taper length, weeks (race week included). */
  taperWeeks?: 1 | 2 | 3;
  /** A mid-week medium-long run. */
  mediumLong?: boolean;
  /** Marathon-pace finishes in the long runs (marathon). */
  mpLong?: boolean;
  /** Weekly mileage increase while building (0.03 = 3%); unset: the level's, spread over the build. */
  growth?: number;
  /** Which kinds of speed work to use. */
  kinds?: SessionKind[];
  /** Hill sprints (8 × 10 s) on an easy day. */
  hillSprints?: boolean;
  /** Strides after an easy run. */
  strides?: boolean;
}

/** The longest build the builder makes. */
export const MAX_WEEKS = 60;
/** Taper by length (fractions of peak; the last is race week). */
const TAPERS: Record<1 | 2 | 3, number[]> = { 1: [0.5], 2: [0.72, 0.45], 3: [0.8, 0.62, 0.42] };

interface LevelSpec {
  label: string;
  blurb: string;
  growth: number;
  cutEvery: number;
  cut: number;
  quality: number;
  peak: Record<RaceDist, number>;
  longCap: Record<RaceDist, number>;
  /** How much fitter the paces get over the plan (VDOT points per week, capped). */
  gain: number;
}

export const LEVELS: Record<Level, LevelSpec> = {
  beginner: {
    label: "Beginner",
    blurb: "Gentle build, one harder session a week, an easier week every third week.",
    growth: 0.05,
    cutEvery: 3,
    cut: 0.75,
    quality: 1,
    peak: { marathon: 55, half: 40, "10k": 32, "5k": 28 },
    longCap: { marathon: 30, half: 18, "10k": 14, "5k": 12 },
    gain: 0.08,
  },
  intermediate: {
    label: "Intermediate",
    blurb: "Steady build, two sessions a week, an easier week every fourth week.",
    growth: 0.07,
    cutEvery: 4,
    cut: 0.8,
    quality: 2,
    peak: { marathon: 75, half: 55, "10k": 45, "5k": 40 },
    longCap: { marathon: 32, half: 21, "10k": 16, "5k": 14 },
    gain: 0.1,
  },
  advanced: {
    label: "Advanced",
    blurb: "Higher mileage, a mid-week medium-long run and race-pace long runs.",
    growth: 0.08,
    cutEvery: 4,
    cut: 0.8,
    quality: 2,
    peak: { marathon: 95, half: 72, "10k": 62, "5k": 55 },
    longCap: { marathon: 34, half: 24, "10k": 19, "5k": 16 },
    gain: 0.12,
  },
  elite: {
    label: "Elite",
    blurb: "Pfitzinger-level volume: 100 km+ weeks for a marathon, long runs to 35 km.",
    growth: 0.1,
    cutEvery: 4,
    cut: 0.82,
    quality: 2,
    peak: { marathon: 120, half: 90, "10k": 80, "5k": 70 },
    longCap: { marathon: 36, half: 26, "10k": 22, "5k": 18 },
    gain: 0.12,
  },
};

export const DEFAULT_WEEKS: Record<RaceDist, number> = { marathon: 16, half: 12, "10k": 10, "5k": 8 };
const TAPER: Record<RaceDist, number[]> = { marathon: [0.8, 0.62, 0.42], half: [0.75, 0.5], "10k": [0.8, 0.55], "5k": [0.6] };

// ---- Your training -------------------------------------------------------------------

export interface History {
  /** Average km a week over the last 4 complete weeks. */
  recent4: number;
  /** …and over the last 12. */
  recent12: number;
  /** Biggest week in the last 12. */
  peak12: number;
  runsPerWeek: number;
  /** Longest run in the last 8 weeks, km. */
  longest8: number;
  /** Weeks with any running, of the last 12. */
  weeksRun12: number;
  /** Current fitness (VDOT), when known. */
  vdot: number | null;
}

export function summarizeHistory(runs: Run[], today: string, vdot: number | null): History {
  const last = addDays(mondayOf(today), -7);
  const weeks = weeklyTotals(runs, addDays(last, -11 * 7), last);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const r4 = weeks.slice(-4);
  return {
    recent4: avg(r4.map((w) => w.km)),
    recent12: avg(weeks.map((w) => w.km)),
    peak12: Math.max(0, ...weeks.map((w) => w.km)),
    runsPerWeek: avg(weeks.map((w) => w.runs)),
    longest8: Math.max(0, ...weeks.slice(-8).map((w) => w.longest)),
    weeksRun12: weeks.filter((w) => w.runs > 0).length,
    vdot,
  };
}

const startKmFor = (h: History) => Math.max(15, Math.round(Math.max(h.recent4, h.recent12 * 0.8)));
const capForDays = (days: number, d: RaceDist, lv: Level) => days * 15 + LEVELS[lv].longCap[d] * 0.5;

/** What a plan would use if you don't change it (for the fine-tune controls). */
export function tuneDefaults(h: History, o: BuildOptions): Required<Omit<Tune, "mpLong" | "mediumLong" | "growth" | "quality">> & { mpLong: boolean; mediumLong: boolean; growth: number; quality: 1 | 2 | 3 } {
  const L = LEVELS[o.level];
  const g = goalShape(o.goal, h, o);
  return {
    peakKm: g.peak ?? peakFor(h, o),
    startKm: g.start ?? startKmFor(h),
    growth: L.growth,
    kinds: ALL_KINDS,
    hillSprints: false,
    strides: true,
    longest: L.longCap[o.dist],
    quality: (o.goal === "mileage" || o.goal === "base" ? 1 : L.quality >= 2 ? 2 : 1) as 1 | 2 | 3,
    cutEvery: L.cutEvery as 3 | 4 | 5,
    taperWeeks: Math.min(3, TAPER[o.dist].length) as 1 | 2 | 3,
    mediumLong: (o.dist === "marathon" || o.dist === "half") && o.days >= 5 && o.level !== "beginner",
    mpLong: o.dist === "marathon",
  };
}

/** Start and peak for the goals that aren't a race (a race uses the level's). */
function goalShape(goal: Goal | undefined, h: History, o: Pick<BuildOptions, "level" | "dist">): { start?: number; peak?: number } {
  const s0 = startKmFor(h);
  const cap = LEVELS[o.level].peak.marathon * 1.1;
  if (goal === "mileage") return { start: s0, peak: Math.round(Math.min(cap, s0 * 1.35)) };
  if (goal === "base") return { start: s0, peak: Math.round(Math.min(cap, s0 * 1.15)) };
  if (goal === "faster") return { start: s0, peak: Math.round(s0 * 1.08) };
  if (goal === "recover") {
    const st = Math.max(10, Math.round(Math.max(h.recent4, h.recent12 * 0.6) * 0.5));
    return { start: st, peak: Math.round(st * 1.5) };
  }
  return {};
}

/** The peak a level aims for, given where you start, the days you run and the weeks you have. */
export function peakFor(h: History, o: Pick<BuildOptions, "dist" | "level" | "days" | "weeks">): number {
  const L = LEVELS[o.level];
  const start = startKmFor(h);
  const build = Math.max(1, o.weeks - TAPER[o.dist].length);
  const growthWeeks = build - Math.floor(build / L.cutEvery);
  const reachable = start * Math.pow(1 + L.growth, Math.max(0, growthWeeks - 1));
  return Math.round(Math.max(start, Math.min(L.peak[o.dist], reachable, capForDays(o.days, o.dist, o.level))));
}

export interface Recommendation {
  level: Level;
  days: number;
  weeks: number;
  why: string[];
}

/**
 * A suggested level, days a week and length. `needKm` is the weekly volume a
 * marathon at your fitness needs (from marathon shape): the suggestion aims
 * to peak a little above it, when that's reachable from where you are.
 */
export function recommend(
  h: History,
  dist: RaceDist,
  weeksAvailable: number,
  firstMonday: string,
  needKm: number | null = null,
  /** Your training as it will be when a plan of n weeks starts (following the current plan until then). */
  atStart: (weeks: number) => History = () => h,
): Recommendation {
  const why: string[] = [];
  const order: Level[] = ["beginner", "intermediate", "advanced", "elite"];
  let weeks = Math.max(4, Math.min(weeksAvailable, DEFAULT_WEEKS[dist] + (dist === "marathon" ? 4 : 2)));
  let days = Math.round(h.runsPerWeek) + 1;
  if (dist === "marathon") days = Math.max(days, 4);
  days = Math.max(3, Math.min(6, days));
  const daysWhy = `You've run ${h.runsPerWeek.toFixed(1)} times a week lately, so ${days} days a week is a small step up.`;
  // The highest level whose peak you can reach from where you are, and that your recent weeks support.
  let level: Level = "beginner";
  for (const lv of order) {
    const peak = peakFor(atStart(weeks), { dist, level: lv, days, weeks });
    if (peak >= LEVELS[lv].peak[dist] * 0.85 && h.recent12 >= LEVELS[lv].peak[dist] * 0.55) level = lv;
  }
  if (h.vdot != null && h.vdot >= 55 && level === "beginner") level = "intermediate";
  const goal = needKm ? Math.round(needKm * 1.05) : null;
  const baseDays = days;
  if (goal && h.weeksRun12 >= 8) {
    // Step up (level, then days, then weeks) until the plan peaks where a marathon at your fitness needs.
    const reach = () => peakFor(atStart(weeks), { dist, level, days, weeks });
    for (let n = 0; n < 12 && reach() < goal; n++) {
      if (order.indexOf(level) < 3 && LEVELS[level].peak[dist] < goal && h.recent12 >= LEVELS[order[order.indexOf(level) + 1]].peak[dist] * 0.4) level = order[order.indexOf(level) + 1];
      else if (days < 6 && capForDays(days, dist, level) < goal) days++;
      else if (weeks < Math.min(weeksAvailable, 24)) weeks += 2;
      else if (days < 7 && capForDays(days, dist, level) < goal) days++;
      else break;
    }
    why.push(
      reach() >= goal
        ? `At your fitness a marathon needs about ${Math.round(needKm!)} km weeks; this peaks at ${reach()} km so you reach 100% marathon shape.`
        : `At your fitness a marathon needs about ${Math.round(needKm!)} km weeks; ${reach()} km is as high as is safe from where you are in the time there is.`,
    );
  }
  why.unshift(days > baseDays ? `You've run ${h.runsPerWeek.toFixed(1)} times a week lately; ${days} days a week makes room for the mileage a marathon needs (shorter runs, not longer ones).` : daysWhy);
  if (h.weeksRun12 < 8 && level !== "beginner") {
    level = order[order.indexOf(level) - 1];
    why.push(`You ran in ${h.weeksRun12} of the last 12 weeks, so it starts a level lower to rebuild consistency.`);
  }
  const hs = atStart(weeks);
  why.push(`${LEVELS[level].label}: from ${startKmFor(hs)} km a week to about ${peakFor(hs, { dist, level, days, weeks })} km${h.recent12 > 0 ? `; your 12-week average is ${Math.round(h.recent12)} km` : ""}.`);
  if (hs !== h && weeksAvailable > weeks) why.push(`It starts from where your current plan has you by then (${Math.round(hs.recent4)} km weeks, long runs to ${Math.round(hs.longest8)} km).`);
  else if (h.recent12 > 0 && h.recent4 < h.recent12 * 0.75)
    why.push(`Your last 4 weeks (${Math.round(h.recent4)} km a week) are well below the 12-week average, so it starts from ${startKmFor(h)} km rather than where you were.`);
  weeks = Math.min(weeks, weeksAvailable);
  if (weeksAvailable > weeks) why.push(`${weeks} weeks is enough: it starts on ${fmtDay(addDays(firstMonday, (weeksAvailable - weeks) * 7))}, and your current plan runs until then.`);
  return { level, days, weeks, why };
}

// ---- Paces ---------------------------------------------------------------------------

const fmtPace = (s: number) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};
const range = (a: number, b: number) => `${fmtPace(a)}–${fmtPace(b)}`;
const around = (s: number, d = 2) => range(s - d, s + d);
const fmtDay = (d: string) => {
  const x = new Date(d + "T12:00");
  return `${x.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][x.getMonth()]}`;
};

export interface Paces {
  mp: number;
  hmp: number;
  tenk: number;
  fivek: number;
  interval: number;
  threshold: number;
  easy: [number, number];
  long: [number, number];
  recovery: [number, number];
}

/** Training paces (s/km) for a VDOT. */
export function pacesFor(v: number): Paces {
  const per = (m: number) => predictTime(m, v) / (m / 1000);
  const mp = per(42195);
  // Threshold: the pace you could hold for about an hour.
  let lo = 5000;
  let hi = 30000;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (predictTime(m, v) < 3600) lo = m;
    else hi = m;
  }
  return {
    mp,
    hmp: per(21097.5),
    tenk: per(10000),
    fivek: per(5000),
    interval: per(5000) - 4,
    threshold: per(lo),
    easy: [mp * 1.2, mp * 1.36],
    long: [mp * 1.14, mp * 1.27],
    recovery: [mp * 1.4, mp * 1.5],
  };
}

// ---- Sessions ------------------------------------------------------------------------

const WARM = 5;
const JOG = 360;
const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.max(0, Math.min(1, t));
const r1 = (x: number) => Math.round(x);
/** "{total} km with …": total = warm-up/cool-down + work + jogs. */
function workout(work: number, jogSeconds: number, text: string) {
  return { km: r1(WARM + work + jogSeconds / JOG), text };
}
function reps(n: number, km: number, pace: number, jog: string, jogSec: number) {
  const size = km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m`;
  return workout(n * km, (n - 1) * jogSec, `${n} × ${size} at ${around(pace)}, ${jog}`);
}
function tempo(min: number, pace: number) {
  return workout((min * 60) / pace, 0, `${min} min T at ${around(pace)}`);
}

/** Half-marathon-pace reps say so ("at HMP 3:35–3:39"), so the paces and readiness know what they are. */
const hmp = (w: { km: number; text: string }) => ({ ...w, text: w.text.replace(" at ", " at HMP ") });


/** The kinds of speed work a plan can use (you choose which in the builder). */
export type SessionKind = "intervals" | "threshold" | "tempo" | "fartlek" | "progression" | "hills" | "racepace";
export const SESSION_KINDS: { id: SessionKind; label: string; blurb: string }[] = [
  { id: "intervals", label: "Intervals", blurb: "400 m to 1.2 km reps at 5k pace (VO2 max)" },
  { id: "threshold", label: "Threshold reps", blurb: "1–3 km reps at threshold, short jogs" },
  { id: "tempo", label: "Tempo runs", blurb: "20–35 min continuous at threshold" },
  { id: "fartlek", label: "Fartlek", blurb: "Minutes on, minutes off, by feel and pace" },
  { id: "progression", label: "Progression runs", blurb: "Start easy, finish at marathon pace or faster" },
  { id: "hills", label: "Hill reps", blurb: "60 s uphill hard, jog back down" },
  { id: "racepace", label: "Race pace", blurb: "Sessions at your goal race pace (late in the plan)" },
];
export const ALL_KINDS: SessionKind[] = SESSION_KINDS.map((k) => k.id);

type Phase = "base" | "build" | "specific" | "taper" | "race" | "recover";
const PHASE_NAME: Record<Phase, string> = { base: "Base", build: "Build", specific: "Race-specific", taper: "Taper", race: "Race week", recover: "Recovery" };

/** Which kinds suit each phase, best first; a week takes the next ones round, so they vary week to week. */
const PREFS: Record<Phase, SessionKind[]> = {
  base: ["fartlek", "progression", "threshold", "hills", "tempo"],
  build: ["intervals", "threshold", "fartlek", "tempo", "hills", "progression"],
  specific: ["racepace", "threshold", "intervals", "tempo", "progression", "fartlek"],
  taper: ["racepace", "intervals", "fartlek"],
  race: ["racepace"],
  recover: ["fartlek", "progression"],
};

interface Q {
  km: number;
  text: string;
  /** The text describes the whole run ("14 km progression run, …"), not a session inside one. */
  whole?: boolean;
  kind: SessionKind;
}

/** One session of a kind; `v` picks the variation (they rotate), `t` is progress through the phase (0–1). */
function session(kind: SessionKind, v: number, o: BuildOptions, phase: Phase, t: number, p: Paces, race: number): Q {
  const big = o.level === "advanced" || o.level === "elite" ? 1 : o.level === "intermediate" ? 0.5 : 0;
  const n = (a: number, b: number) => Math.round(lerp(a, b, t) + big);
  const T = p.threshold;
  const short = phase === "taper" || phase === "race";
  const pick = <X,>(xs: X[]) => xs[((v % xs.length) + xs.length) % xs.length];
  const q = (w: { km: number; text: string }, whole = false): Q => ({ ...w, kind, whole });
  switch (kind) {
    case "intervals":
      if (short) return q(reps(4, 1, p.interval, "2 min jog", 120));
      return q(
        pick([
          () => reps(n(4, 6), 1, p.interval, "2 min jog", 120),
          () => reps(n(5, 8), 0.8, p.interval, "90 s jog", 90),
          () => reps(n(3, 5), 1.2, p.interval, "2 min jog", 120),
          () => reps(n(10, 14), 0.4, p.interval - 6, "60 s jog", 60),
        ])(),
      );
    case "threshold":
      if (short) return q(reps(3, 1, T, "2 min jog", 120));
      return q(
        pick([
          () => reps(n(3, 4), 2, T, "2 min jog", 120),
          () => reps(Math.min(4, n(2, 3)), 3, T, "2 min jog", 120),
          () => reps(n(4, 5), 1.5, T, "60 s jog", 60),
        ])(),
      );
    case "tempo":
      return q(tempo(short ? 15 : r1(lerp(20, 32, t) + big * 3), T));
    case "fartlek": {
      const [k, mins, at, off] = pick([
        [n(8, 12), 2, p.tenk, "1 min jog"],
        [n(5, 7), 3, T, "90 s jog"],
        [n(10, 15), 1, p.fivek, "1 min jog"],
      ] as [number, number, number, string][]);
      const reps_ = short ? Math.min(k, 6) : k;
      const offSec = /90/.test(off) ? 90 : 60;
      return q(workout((reps_ * mins * 60) / at, (reps_ - 1) * offSec, `${reps_} × ${mins} min fartlek at ${around(at)}, ${off}`));
    }
    case "progression": {
      const total = r1(lerp(10, 16, t) + big * 2);
      const fast = Math.max(2, r1(lerp(3, 6, t)));
      const at = phase === "base" || phase === "recover" ? p.mp : pick([p.mp, T]);
      return q({ km: total, text: `${total} km progression run, last ${fast} at ${around(at, 3)}` }, true);
    }
    case "hills": {
      const k = short ? 6 : n(6, 10);
      return q(workout(k * 0.3, k * 90, `${k} × 60 s hill reps, jog back down`));
    }
    case "racepace": {
      if (o.dist === "marathon") {
        const mp = short ? 6 : r1(lerp(8, 14, t) + big * 2);
        return q(workout(mp, 0, `${mp} km at MP ${around(race)}`));
      }
      if (o.dist === "half") return q(hmp(short ? reps(3, 2, race, "2 min jog", 120) : reps(n(3, 4), pick([3, 4, 5]), race, "2 min jog", 120)));
      if (o.dist === "10k") return q(short ? reps(5, 1, race, "2 min jog", 120) : pick([() => reps(n(3, 5), 2, race, "2 min jog", 120), () => reps(n(4, 6), 1.5, race, "90 s jog", 90)])());
      return q(short ? reps(5, 0.4, race, "200 m jog", 70) : pick([() => reps(n(4, 6), 1, race, "2 min jog", 120), () => reps(n(8, 12), 0.4, race - 3, "200 m jog", 70)])());
    }
  }
}

/** The week's quality sessions: race pace first late in the plan, otherwise the phase's kinds in turn (no repeats in a week). */
function pickSessions(count: number, phase: Phase, week: number, kinds: Set<SessionKind>, o: BuildOptions, t: number, p: Paces, race: number): Q[] {
  const prefs = PREFS[phase].filter((k) => kinds.has(k));
  const out: Q[] = [];
  const used = new Set<SessionKind>();
  for (let j = 0; j < count && prefs.length; j++) {
    let k: SessionKind;
    if (j === 0 && phase !== "base" && phase !== "build" && phase !== "recover" && prefs.includes("racepace")) k = "racepace";
    else {
      const pool = prefs.filter((x) => !used.has(x) && !(x === "racepace" && (phase === "base" || phase === "build")));
      if (!pool.length) break;
      k = pool[(week + j * 2) % pool.length];
    }
    used.add(k);
    out.push(session(k, Math.floor(week / Math.max(1, prefs.length)) + j, o, phase, t, p, race));
  }
  return out;
}

// ---- The plan ------------------------------------------------------------------------

/** Run days for a number of days a week (long run on Sunday; shifted a day for Saturday). */
const PATTERN: Record<number, DayKey[]> = {
  3: ["tue", "thu", "sun"],
  4: ["tue", "thu", "fri", "sun"],
  5: ["tue", "wed", "thu", "sat", "sun"],
  6: ["mon", "tue", "wed", "thu", "sat", "sun"],
  7: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
};
const IDX = (k: DayKey) => WEEK_KEYS.indexOf(k);
const shift = (k: DayKey, by: number) => WEEK_KEYS[(IDX(k) + by + 7) % 7];

export interface BuiltWeek {
  monday: string;
  phase: Phase;
  km: number;
  long: number;
  cut: boolean;
}

/** The plan built from the options, merged into the current one: weeks before it and after the race are kept. */
export function buildPlan(old: Plan, o: BuildOptions, h: History, today: string): { plan: Plan; weeks: BuiltWeek[] } {
  const T = o.tune ?? {};
  const L0 = LEVELS[o.level];
  const L: LevelSpec = {
    ...L0,
    quality: T.quality ?? L0.quality,
    cutEvery: T.cutEvery === 0 ? 999 : (T.cutEvery ?? L0.cutEvery),
    longCap: { ...L0.longCap, [o.dist]: T.longest ?? L0.longCap[o.dist] },
  };
  const raceMonday = mondayOf(o.raceDate);
  const firstAllowed = mondayOf(today) < today ? addDays(mondayOf(today), 7) : mondayOf(today);
  let start = addDays(raceMonday, -(o.weeks - 1) * 7);
  if (start < firstAllowed) start = firstAllowed;
  const N = Math.max(1, diffDays(start, raceMonday) / 7 + 1);
  const goal: Goal = o.goal ?? "race";
  const isRace = goal === "race";
  const taperAll = !isRace ? (goal === "faster" ? [0.8] : []) : T.taperWeeks ? TAPERS[T.taperWeeks] : TAPER[o.dist];
  const taper = taperAll.slice(-Math.max(isRace ? 1 : 0, Math.min(taperAll.length, N - 2)));
  const buildN = Math.max(0, N - taper.length);
  // A long build spends the extra weeks on base (aerobic volume); race-specific work stays at most ~12 weeks.
  let specN = buildN >= 4 ? Math.min(12, Math.max(2, Math.round(buildN * 0.3))) : buildN;
  let baseN = buildN >= 6 ? Math.max(Math.round(buildN * 0.3), buildN - specN - 12) : buildN >= 3 ? 1 : 0;
  if (goal === "base" || goal === "recover") [baseN, specN] = [buildN, 0];
  else if (goal === "mileage") [baseN, specN] = [Math.round(buildN * 0.5), 0];
  else if (goal === "faster") [baseN, specN] = [Math.round(buildN * 0.25), Math.max(1, Math.round(buildN * 0.3))];
  const gs = goalShape(goal, h, o);
  const peak = Math.round(T.peakKm ?? gs.peak ?? peakFor(h, { ...o, weeks: N }));
  const startKm = Math.min(T.startKm ?? gs.start ?? startKmFor(h), peak);
  // Weekly growth: the level's at most, but spread over the whole build so a long one doesn't peak months early.
  const cutsN = Array.from({ length: buildN }, (_, i) => i > 0 && (i + 1) % L.cutEvery === 0 && i < buildN - 1).filter(Boolean).length;
  const rampWeeks = Math.max(1, buildN - cutsN - Math.min(4, Math.round(buildN * 0.15)));
  // Your own rate (Fine-tune) is used as set: the plan reaches its peak sooner and holds it.
  const growth = T.growth ?? Math.max(0.015, Math.min(L.growth, Math.pow(peak / Math.max(1, startKm), 1 / rampWeeks) - 1));

  // Paces: fitness now, rising a little through the plan; race-pace work at the goal pace.
  const v0 = h.vdot ?? 42;
  const goalSec = o.target ? targetTime(o.target, DIST_M[o.dist]) : null;
  const vGoal = goalSec ? vdotOf(DIST_M[o.dist], goalSec) : null;
  // Fitness you can expect to gain: about a VDOT point a month, less as it adds up (a long build gains more, but not linearly).
  const vEnd = goal === "recover" || goal === "base" || goal === "mileage" ? v0 + Math.min(1, N * 0.05) : Math.max(v0, Math.min(vGoal ?? v0 + 9, v0 + expectedGain(N, o.level)));
  const paceAt = (i: number) => pacesFor(lerp(v0, vEnd, i / Math.max(1, N - 1)));
  const racePaceOf = (p: Paces) => (o.dist === "marathon" ? p.mp : o.dist === "half" ? p.hmp : o.dist === "10k" ? p.tenk : p.fivek);
  const goalPace = goalSec ? goalSec / (DIST_M[o.dist] / 1000) : null;

  // Weekly km and long runs.
  const built: BuiltWeek[] = [];
  let cur = startKm;
  const frac = (o.dist === "marathon" ? { 3: 0.45, 4: 0.4, 5: 0.36, 6: 0.33, 7: 0.3 } : { 3: 0.4, 4: 0.35, 5: 0.3, 6: 0.28, 7: 0.26 })[o.days] ?? 0.3;
  // Where the long run starts: a bit below your recent longest, but not a huge share of the first week.
  let longMax = Math.max(8, Math.min(L.longCap[o.dist] * 0.8, h.longest8 > 0 ? Math.min(h.longest8 * 0.75, startKm * 0.42) : startKm * frac) - 2);
  let peakLong = 0;
  for (let i = 0; i < N; i++) {
    const monday = addDays(start, i * 7);
    let phase: Phase = i < baseN ? "base" : i < buildN - specN ? "build" : i < buildN ? "specific" : i === N - 1 ? "race" : "taper";
    if (buildN === 0 && i < N - 1) phase = "taper";
    if (goal === "recover") phase = "recover";
    if (goal === "faster" && phase === "race") phase = "taper";
    let km: number;
    let long: number;
    let cut = false;
    if (i < buildN) {
      cut = i > 0 && (i + 1) % L.cutEvery === 0 && i < buildN - 1;
      if (i > 0 && !cut) cur = Math.min(peak, cur * (1 + growth));
      km = cut ? cur * L.cut : cur;
      // Race-specific weeks push the long run on towards its cap; before that it follows the week's volume.
      const want = Math.min(L.longCap[o.dist], phase === "specific" && isRace ? Math.max(km * frac, L.longCap[o.dist]) : phase === "recover" ? km * 0.28 : km * frac);
      long = cut ? Math.min(want, longMax * 0.8) : Math.min(want, longMax + 2);
      long = Math.max(o.dist === "5k" ? 8 : 10, Math.round(long));
      if (!cut) longMax = Math.max(longMax, long);
      peakLong = Math.max(peakLong, long);
    } else {
      const k = taper[i - buildN];
      km = Math.max(peak, cur) * k;
      long = phase === "race" ? 0 : Math.round(Math.max(10, peakLong * (k + 0.05)));
    }
    built.push({ monday, phase, km: Math.round(km), long, cut });
  }

  // Races inside the new plan.
  const end = addDays(raceMonday, 6);
  const goalRace: PlanRace = {
    date: o.raceDate,
    approx: false,
    when: fmtDay(o.raceDate),
    name: o.raceName || DIST_LABEL[o.dist],
    target: o.target,
    role: "Goal race",
  };
  const inside = old.races.filter((r) => r.date && !r.approx && r.date >= start && r.date <= end && r.date !== o.raceDate);
  // Tune-ups get the taper you chose for them (Races), else one that fits how much they matter; applied when the plan loads.
  const tuneUps = o.keepRaces ? inside.map((r) => ({ ...r, taper: r.taper ?? (priorityOf(r) === "A" || priorityOf(r) === "B" ? ("mini" as const) : ("none" as const)) })) : [];

  // Write each week day by day.
  const longDay: DayKey = o.longDay;
  const by = longDay === "sat" ? -1 : 0;
  const run = (PATTERN[o.days] ?? PATTERN[5]).map((k) => shift(k, by));
  const q1 = shift("tue", by);
  const q2 = o.days >= 4 ? shift("thu", by) : null;
  const weeks: PlanWeek[] = built.map((b, i) => {
    const p = paceAt(i);
    const rp = goalPace && Math.abs(goalPace - racePaceOf(p)) < 25 ? goalPace : racePaceOf(p);
    const s: Partial<Record<DayKey, string>> = {};
    const sized: Partial<Record<DayKey, number>> = {};
    const raceHere = [...tuneUps, ...(b.phase === "race" && isRace ? [goalRace] : [])].filter((r) => r.date! >= b.monday && r.date! <= addDays(b.monday, 6));
    const raceDays = new Set(raceHere.map((r) => WEEK_KEYS[diffDays(b.monday, r.date!)]));
    const near = (k: DayKey) => [...raceDays].some((r) => Math.abs(IDX(r) - IDX(k)) <= 1);
    const t = b.phase === "base" ? i / Math.max(1, baseN) : b.phase === "build" ? (i - baseN) / Math.max(1, buildN - specN - baseN) : (i - (buildN - specN)) / Math.max(1, specN);
    const alt = i % 2 === 1;
    // Tune-up race weeks get the taper's lighter sessions.
    const tune = raceHere.length > 0 && b.phase !== "race";
    const kinds = new Set<SessionKind>(T.kinds ?? ALL_KINDS);
    const qPhase: Phase = b.phase === "race" || tune ? "taper" : b.phase;
    let nQ = Math.min(T.quality ?? (goal === "mileage" || goal === "base" ? 1 : L.quality), o.days >= 6 ? 3 : o.days >= 4 ? 2 : 1);
    if (b.phase === "taper" || b.phase === "race" || raceHere.length) nQ = Math.min(nQ, 1);
    if (o.level === "beginner" && b.phase === "base" && i < 2) nQ = 0;
    // Recovering: easy only at first, then one light session in the second half.
    if (goal === "recover") nQ = i >= N / 2 && N >= 3 ? Math.min(1, nQ) : 0;
    let km = b.km;
    if (raceHere.length && b.phase !== "race") km = Math.round(km - raceHere.reduce((a, r) => a + (r.km ?? raceKm(r.name) ?? 10), 0));

    for (const r of raceHere) s[WEEK_KEYS[diffDays(b.monday, r.date!)]] = r.name;
    // Long run: on its day unless a race is there or the day before/after.
    let longAt: DayKey | null = null;
    let longHard = false;
    const lastFaster = goal === "faster" && i === N - 1;
    if (b.long > 0 && !raceDays.has(longDay) && !near(longDay)) {
      longAt = longDay;
      const mpAuto = isRace && o.dist === "marathon" && b.phase === "specific" && !b.cut && L.quality >= 2 && o.level !== "intermediate" ? r1(lerp(8, 16, t)) : isRace && o.dist === "marathon" && b.phase === "specific" && !b.cut && alt ? 8 : 0;
      const withMp = T.mpLong === false ? 0 : T.mpLong && o.dist === "marathon" && b.phase === "specific" && !b.cut ? r1(lerp(8, 16, t)) : mpAuto;
      longHard = withMp > 0 && b.long >= 20;
      if (lastFaster) {
        // The block ends with a time trial: see what you've gained.
        s[longDay] = `${WARM + 5} km with 5 km time trial: 5 km at ${around(p.fivek)}`;
        sized[longDay] = WARM + 5;
      } else {
        s[longDay] = longHard ? `${b.long} km long run, last ${withMp} at MP ${around(rp, 3)}` : `${b.long} km long run`;
        sized[longDay] = b.long;
      }
    }
    // Marathon pace in the long run makes it a hard day: one session fewer, and no race-pace session on top.
    if (longHard) {
      nQ = Math.max(0, nQ - 1);
      kinds.delete("racepace");
    }
    let picks = pickSessions(nQ, qPhase, i, kinds, o, t, p, rp);
    // Before the race-specific weeks, a tune-up week keeps a short threshold session rather than race-pace work.
    if (tune && (b.phase === "base" || b.phase === "build") && picks.length) picks = [{ ...reps(4, 1, p.threshold, "90 s jog", 90), kind: "threshold" }];
    // Quality days: Tuesday and Thursday (shifted for a Saturday long run); a third on the day before the long run.
    const qDays = [q1, q2, o.days >= 6 ? shift(longDay, -1) : null];
    picks.forEach((q, j) => {
      const d = qDays[j];
      if (!d || raceDays.has(d) || near(d) || s[d]) return;
      s[d] = q.whole ? q.text : `${q.km} km with ${q.text}`;
      sized[d] = q.km;
    });
    // Hill sprints (if you want them): short and fast on an easy day in base and build weeks.
    if (T.hillSprints && (b.phase === "base" || b.phase === "build") && !b.cut) {
      const afterLong = longAt ? WEEK_KEYS[(IDX(longAt) + 1) % 7] : null;
      const d = [q2, q1, ...run].find((x) => x && !s[x] && x !== afterLong && !raceDays.has(x) && !near(x) && run.includes(x));
      if (d) {
        const k = r1(Math.max(8, Math.min(14, km * 0.14)));
        s[d] = `${k} km easy + 8 × 10 s hill sprints`;
        sized[d] = k;
      }
    }
    // Medium-long run mid-week (marathon and half, five days or more, not beginners).
    const freeDays = run.filter((k) => !s[k]);
    const mlAuto = (o.dist === "marathon" || o.dist === "half") && o.days >= 5 && o.level !== "beginner";
    const mlOk = (T.mediumLong ?? mlAuto) && o.days >= 4 && (b.phase === "build" || b.phase === "specific") && !b.cut;
    if (mlOk && longAt && b.long >= 18) {
      const gap = (k: DayKey) => Math.min(Math.abs(IDX(k) - IDX(longAt!)), 7 - Math.abs(IDX(k) - IDX(longAt!)));
      const at = freeDays.filter((k) => gap(k) >= 3 && !near(k)).sort((a, b) => gap(b) - gap(a))[0];
      if (at) {
        const k = r1(Math.min(o.dist === "marathon" ? 22 : 16, Math.max(14, b.long * 0.62)));
        s[at] = `${k} km medium-long run`;
        sized[at] = k;
      }
    }
    // Easy days take what's left of the week.
    const easy = run.filter((k) => !s[k]);
    const used = Object.values(sized).reduce((a, x) => a + (x ?? 0), 0);
    const left = Math.max(0, km - used);
    const each = easy.length ? left / easy.length : 0;
    let strides = T.strides !== false && (b.phase !== "base" || o.level !== "beginner") && b.phase !== "recover";
    for (const k of easy) {
      const after = longAt && IDX(k) === (IDX(longAt) + 1) % 7;
      const before = [...raceDays].some((r) => IDX(r) - IDX(k) === 1);
      const cap = after ? Math.max(6, each * 0.8) : tune ? 10 : 16;
      const kk = Math.max(before ? 4 : 5, r1(Math.min(cap, before ? 5 : each)));
      let text = `${kk} km ${after ? "recovery" : "easy"}`;
      if (before) text = `${kk} km easy + 4 × 20 s strides`;
      else if (strides && !after && !near(k) && !(longAt && Math.abs(IDX(k) - IDX(longAt)) === 1)) {
        text += " + 6 × 20 s strides";
        strides = false;
      }
      s[k] = text;
      sized[k] = kk;
    }
    for (const k of WEEK_KEYS) if (!s[k]) s[k] = "Rest";
    const total = Object.values(sized).reduce((a, x) => a + (x ?? 0), 0);
    const notes =
      b.phase === "race"
        ? `Race week: short and sharp, then ${goalRace.name}.`
        : b.cut
          ? "Easier week: less volume, same sessions, to absorb the last few weeks."
          : raceHere.length
            ? `Tune-up race: ${raceHere.map((r) => r.name).join(", ")}. Lighter week around it.`
            : "";
    return {
      week: String(i + 1),
      start: b.monday,
      end: addDays(b.monday, 6),
      phase: PHASE_NAME[b.phase],
      km: b.phase === "race" ? `about ${total} + race` : String(total),
      kmMin: total,
      kmMax: total,
      sessions: s,
      notes,
    };
  });
  built.forEach((b, i) => (b.km = weeks[i].kmMin ?? b.km));

  // Phases, with what each is for.
  const phases: Plan["phases"] = [];
  for (const ph of ["recover", "base", "build", "specific", "taper"] as Phase[]) {
    const ws = built.filter((b) => b.phase === ph || (ph === "taper" && b.phase === "race"));
    if (!ws.length) continue;
    const kms = ws.map((w) => w.km);
    const lo = Math.min(...kms);
    const hi = Math.max(...kms);
    const longs = Math.max(...ws.map((w) => w.long));
    const what: Record<Phase, string> = {
      base: `${lo}–${hi} km, easy running with threshold intervals and hill sprints, long runs up to ${longs} km.`,
      build: `${lo}–${hi} km, VO2 max intervals and threshold runs${o.days >= 5 && o.level !== "beginner" && o.dist !== "5k" && o.dist !== "10k" ? ", a medium-long run" : ""}, long runs up to ${longs} km.`,
      specific: `${lo}–${hi} km, work at race pace (${o.dist === "marathon" ? "marathon pace in sessions and long runs" : `${DIST_LABEL[o.dist].toLowerCase()} pace`}), long runs up to ${longs} km.`,
      taper: isRace ? `Volume drops (${hi} → ${lo} km) while the sessions stay sharp, so you start ${goalRace.name} fresh.` : `A lighter week, ending with a 5 km time trial to see what you've gained.`,
      race: "",
      recover: `${lo}–${hi} km of easy running${N >= 3 ? ", with one light fartlek or progression run in the later weeks" : ""}: let the legs come back before training hard again.`,
    };
    phases.push({ name: PHASE_NAME[ph], start: ws[0].monday, end: addDays(ws[ws.length - 1].monday, 6), summary: what[ph] });
  }

  const pNow = pacesFor(v0);
  const pEnd = pacesFor(vEnd);
  const zone = (z: string, a: string, b: string, use: string, hr = "") => ({ zone: z, now: a, autumn: b, hr, use });
  const paces: Plan["paces"] = [
    zone("Recovery", range(...pNow.recovery), range(...pEnd.recovery), "The day after the long run"),
    zone("Easy", range(...pNow.easy), range(...pEnd.easy), "Most of your running"),
    zone("Long run (easy part)", range(...pNow.long), range(...pEnd.long), "Long runs"),
    zone("Marathon pace (MP)", around(pNow.mp), around(o.dist === "marathon" && goalPace ? goalPace : pEnd.mp), "Race-pace sections"),
    zone("Half marathon pace (HMP)", around(pNow.hmp), around(o.dist === "half" && goalPace ? goalPace : pEnd.hmp), "Half-specific sessions"),
    zone("Threshold (T)", around(pNow.threshold), around(pEnd.threshold), "Comfortably hard, about 1-hour race effort"),
    zone("10k pace", around(pNow.tenk), around(o.dist === "10k" && goalPace ? goalPace : pEnd.tenk), "10k-specific intervals"),
    zone("5k / VO2 intervals", around(pNow.interval), around(pEnd.interval), "Fast intervals"),
    zone("Strides and hill sprints", "By feel", "By feel", "Fast but relaxed, full recovery"),
  ];
  const peakWeek = Math.max(...built.map((b) => b.km));
  const longest = Math.max(...built.map((b) => b.long));
  const rules = [
    `Most running is easy, at ${range(...pNow.easy)}/km: conversational. The hard days are the sessions and the long run.`,
    `Mileage rises by about ${Math.max(2, Math.round(growth * 100))}% a week, from ${built[0]?.km ?? startKm} to ${peakWeek} km${L.cutEvery >= 999 ? ", with no planned easier weeks" : `, with an easier week every ${({ 3: "third", 4: "fourth", 5: "fifth" } as Record<number, string>)[L.cutEvery] ?? `${L.cutEvery}th`} week`}.`,
    `The long run grows by about 2 km at a time, to ${longest} km, and is never next to a hard session.`,
    `${nQText(o)} Paces come from your current fitness (VDOT ${v0.toFixed(1)})${vEnd > v0 + 0.2 ? ` and rise gently to VDOT ${vEnd.toFixed(1)} by race day` : ""}${goalPace ? `; race-pace work is at your goal pace, ${fmtPace(goalPace)}/km` : ""}.`,
    `${taper.length === 1 ? "A one-week" : `A ${taper.length}-week`} taper: volume drops, intensity stays.`,
    "Missed a session? Skip it rather than squeezing it in. Ill or injured? Easy running only until you're well, then pick the plan up where it is.",
  ];

  const keepBefore = old.weeks.filter((w) => w.end < start);
  const keepAfter = old.weeks.filter((w) => w.start > end);
  const races = [
    ...old.races.filter((r) => !r.date || r.date < start || r.date > end),
    ...tuneUps,
    ...(isRace ? [goalRace] : []),
  ]
    .filter((r, i, all) => all.findIndex((x) => x.date === r.date && x.name === r.name) === i)
    .sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
  const { previous: _p, baseWeeks: _b, prefs: _q, hrZones: _h, ...prev } = old;
  const plan: Plan = {
    ...old,
    title: isRace ? `${goalRace.name}${o.target ? ` · ${o.target}` : ""}` : `${GOALS.find((g) => g.id === goal)!.label}: ${N} weeks`,
    source: `Built in the app on ${fmtDay(today)} ${new Date(today).getFullYear()}`,
    exported: today,
    phases: [...old.phases.filter((p) => p.end && p.end < start), ...phases, ...old.phases.filter((p) => p.start && p.start > end)],
    blocks: old.blocks.filter((b) => !b.start || b.start > end || (b.end && b.end < start)),
    races,
    weeks: [...keepBefore, ...weeks, ...keepAfter],
    paces,
    structure: old.structure,
    rules,
    benchmarks: old.benchmarks.filter((b) => !b.date || b.date < start || b.date > end),
    adjust: null,
    baseWeeks: undefined,
    built: { ...o, weeks: N, start, peak: peakWeek, longest, vdot: v0, vdotEnd: vEnd },
    previous: prev,
  };
  return { plan, weeks: built };
}

/** VDOT points a build of n weeks can be expected to add (diminishing: a year adds less than twice a half-year). */
export function expectedGain(weeks: number, level: Level): number {
  const cap = level === "beginner" ? 6 : level === "intermediate" ? 5 : 4.5;
  return cap * (1 - Math.exp(-weeks / 30));
}

const nQText = (o: BuildOptions) =>
  (o.tune?.quality ?? LEVELS[o.level].quality) >= 2 && o.days >= 4
    ? "Two quality sessions a week (one in easier, tune-up and taper weeks): threshold and VO2 max work early, race-pace work late."
    : "One quality session a week, alternating threshold, VO2 max and race-pace work.";
