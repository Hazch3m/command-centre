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
  /** B and C races you add in the builder (as well as the ones already in your plan). */
  extraRaces?: PlanRace[];
  /** The goal race's course: a kind, or exact climb and descent in metres. */
  terrain?: Terrain;
}

export interface Terrain {
  kind: "flat" | "rolling" | "hilly" | "mountain" | "custom";
  /** Metres of climb and descent (custom; otherwise worked out from the kind and distance). */
  gain?: number;
  loss?: number;
}
const TERRAIN_M_PER_KM: Record<Exclude<Terrain["kind"], "custom">, number> = { flat: 1, rolling: 5, hilly: 12, mountain: 25 };
/** The course's climb and descent in metres. */
export function courseElevation(t: Terrain | undefined, km: number): { gain: number; loss: number } {
  if (!t) return { gain: 0, loss: 0 };
  if (t.kind === "custom") return { gain: Math.max(0, t.gain ?? 0), loss: Math.max(0, t.loss ?? t.gain ?? 0) };
  const g = Math.round(TERRAIN_M_PER_KM[t.kind] * km);
  return { gain: g, loss: g };
}
/** Seconds a course's hills add (climb costs, descent gives some back; a net-downhill course gains only a little). */
export function elevationCost(gain: number, loss: number): number {
  return Math.max(-0.08 * loss, 0.75 * gain - 0.35 * loss);
}

export type Goal = "start" | "beyond5k" | "race" | "faster" | "mileage" | "base" | "recover";
export const GOALS: { id: Goal; label: string; blurb: string; weeks: number }[] = [
  { id: "start", label: "Start running", blurb: "New to running: walk and run, three times a week, to 30 minutes of running without stopping", weeks: 9 },
  { id: "beyond5k", label: "Beyond 5k", blurb: "You can run 5k: run it faster and go further (towards 10k), three or four runs a week with one fun session; ends with a 5k time trial", weeks: 10 },
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
  /** Periodise around tune-up races: the two weeks before a B race sharpen for it (default on). */
  sharpen?: boolean;
  /** Doubles a week: a second short easy run on the same day (0: none). */
  doubles?: 0 | 1 | 2 | 3 | 4;
}

/**
 * When doubles (a second, short, easy run on the same day) make sense: they add volume without
 * making single runs longer or adding a hard day. Worth it from roughly 90–100 km a week, once you
 * already run six or seven days and the easy runs are getting long; not for beginners, and not
 * while rebuilding consistency. More of them the higher the mileage.
 */
export function doublesAdvice(peakKm: number, days: number, level: Level, weeksRun12 = 12): { suggest: 0 | 1 | 2 | 3 | 4; why: string } {
  if (level === "beginner") return { suggest: 0, why: "Not yet: one run a day is plenty while you build the habit and the mileage." };
  if (weeksRun12 < 8) return { suggest: 0, why: "Not yet: get back to running most weeks first; doubles are for adding volume on top of consistency." };
  if (days < 6) return { suggest: 0, why: `Not needed on ${days} days a week: add a running day before a second run in a day.` };
  if (peakKm < 90) return { suggest: 0, why: `Not needed at ${peakKm} km a week: single runs cover it comfortably. Worth it from about 90–100 km a week.` };
  const suggest = (peakKm < 110 ? 1 : peakKm < 130 ? 2 : peakKm < 150 ? 3 : 4) as 1 | 2 | 3 | 4;
  return {
    suggest,
    why: `At ${peakKm} km a week, ${suggest} double${suggest > 1 ? "s" : ""} a week keeps the easy runs a sensible length: more volume with less strain than longer single runs.`,
  };
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
    sharpen: true,
    doubles: 0,
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
  const dAdv = doublesAdvice(peakFor(hs, { dist, level, days, weeks }), days, level, h.weeksRun12);
  if (dAdv.suggest > 0) why.push(`Doubles: ${dAdv.why} Turn them on under Fine-tune.`);
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
/** Every speed session spells out its warm-up and cool-down (3 km and the rest of the 5 km of easy running). */
const WARM_UP = 3;
function withWarmUp(q: { km: number; text: string }) {
  return `${q.km} km with ${WARM_UP} km warm-up, ${q.text}, ${WARM - WARM_UP} km cool-down`;
}

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

/**
 * Marathon and half: like Pfitzinger's or Hansons' plans, threshold work leads the build (with VO2 max
 * reps every so often, never the main thing), race pace takes over late, and the base is strides,
 * hills and progression runs rather than lots of speed.
 */
const PREFS_LONG: Record<Phase, SessionKind[]> = {
  base: ["progression", "hills", "threshold", "fartlek", "tempo"],
  build: ["threshold", "tempo", "intervals", "progression", "hills", "fartlek"],
  specific: ["racepace", "threshold", "tempo", "progression", "intervals"],
  taper: ["racepace", "threshold", "intervals"],
  race: ["racepace"],
  recover: ["progression", "fartlek"],
};

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
      // Marathon VO2 max work is 800 m–1.2 km or 3–4 min at 5K pace with equal-ish jogs, not 200s and 400s.
      if (o.dist === "marathon")
        return q(
          pick([
            () => reps(n(5, 6), 1, p.fivek, "2 min jog", 120),
            () => reps(n(5, 7), 0.8, p.fivek, "90 s jog", 90),
            () => reps(n(4, 5), 1.2, p.fivek, "2:30 jog", 150),
            () => timed(n(4, 5), 3, p.fivek, "", "2 min jog", 120),
            () => reps(n(3, 4), 1.6, p.fivek + 4, "3 min jog", 180),
          ])(),
        );
      return q(
        pick([
          () => reps(n(4, 6), 1, p.interval, "2 min jog", 120),
          () => reps(n(5, 8), 0.8, p.interval, "90 s jog", 90),
          () => reps(n(3, 5), 1.2, p.interval, "2 min jog", 120),
          () => reps(n(10, 14), 0.4, p.interval - 6, "60 s jog", 60),
          () => timed(n(4, 6), 3, p.interval, "", "2 min jog", 120),
          () => reps(n(6, 8), 0.6, p.interval - 3, "90 s jog", 90),
          () => timed(n(3, 5), 4, p.interval + 2, "", "2 min jog", 120),
          () => reps(n(12, 16), 0.2, p.interval - 10, "200 m jog", 70),
        ])(),
      );
    case "threshold":
      if (short) return q(reps(3, 1, T, "2 min jog", 120));
      return q(
        pick([
          () => reps(n(3, 4), 2, T, "2 min jog", 120),
          () => reps(Math.min(4, n(2, 3)), 3, T, "2 min jog", 120),
          () => reps(n(4, 5), 1.5, T, "60 s jog", 60),
          () => timed(n(4, 6), 6, T, "T ", "1 min jog", 60),
          () => timed(3, n(8, 10), T, "T ", "2 min jog", 120),
          () => timed(2, n(12, 16), T, "T ", "3 min jog", 180),
        ])(),
      );
    case "tempo":
      return q(tempo(short ? 15 : r1(lerp(20, 32, t) + big * 3), T));
    case "fartlek": {
      const [k, mins, at, off] = pick([
        [n(8, 12), 2, p.tenk, "1 min jog"],
        [n(5, 7), 3, T, "90 s jog"],
        [n(10, 15), 1, p.fivek, "1 min jog"],
        [n(5, 6), 4, T + 3, "2 min jog"],
        [n(12, 16), 0.75, p.fivek, "75 s jog"],
        [n(15, 20), 0.5, p.interval - 8, "30 s jog"],
      ] as [number, number, number, string][]);
      const reps_ = short ? Math.min(k, 6) : k;
      const secM = /(\d+)\s*s\b/.exec(off);
      const offSec = secM ? +secM[1] : +(/(\d+)\s*min/.exec(off)?.[1] ?? 1) * 60;
      const len = mins >= 1 ? `${mins} min` : `${Math.round(mins * 60)} s`;
      return q(workout((reps_ * mins * 60) / at, (reps_ - 1) * offSec, `${reps_} × ${len} fartlek at ${around(at)}, ${off}`));
    }
    case "progression": {
      const total = r1(lerp(10, 16, t) + big * 2);
      const fast = Math.max(2, r1(lerp(3, 6, t)));
            // Never slower than marathon pace: MP early on, then up to between MP and threshold, or threshold.
      const at = phase === "base" || phase === "recover" ? pick([p.mp, p.mp - 3]) : pick([p.mp, Math.round((p.mp + T) / 2), T]);
      // Easy, then the faster block, then a short easy cool-down to finish.
      const cd = total >= 12 ? 2 : 1.5;
      const easy = r1(Math.max(3, total - fast - cd));
      return q({ km: total, text: `${total} km progression run: ${easy} km easy, ${fast} km at ${around(at, 3)}, ${cd} km easy cool-down` }, true);
    }
    case "hills": {
      const [k, sec] = short ? [6, 60] : pick([[n(6, 10), 60], [n(8, 12), 45], [n(5, 7), 90], [n(5, 6), 120]] as [number, number][]);
      const len = sec >= 120 ? `${sec / 60} min` : `${sec} s`;
      return q(workout(k * (sec / 240), k * sec * 1.4, `${k} × ${len} hill reps, jog back down`));
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

/** What a session is for, written in front of it ("VO2 max: 5 × 1 km at …"). */
const KIND_LABEL: Partial<Record<SessionKind, string>> = { intervals: "VO2 max", threshold: "Threshold", tempo: "Threshold tempo", hills: "Hill strength", racepace: "Race pace" };

/** "5 × 3 min at 3:30–3:34, 2 min jog" (timed reps; `tag` "T " marks threshold). */
function timed(n: number, min: number, pace: number, tag: string, jog: string, jogSec: number) {
  return workout((n * min * 60) / pace, (n - 1) * jogSec, `${n} × ${min} min ${tag}at ${around(pace)}, ${jog}`);
}

/** The week's quality sessions: race pace first late in the plan, otherwise the phase's kinds in turn (no repeats in a week). */
function pickSessions(count: number, phase: Phase, week: number, kinds: Set<SessionKind>, o: BuildOptions, t: number, p: Paces, race: number, seen: Map<SessionKind, number> = new Map()): Q[] {
  let prefs = (o.dist === "marathon" || o.dist === "half" ? PREFS_LONG : PREFS)[phase].filter((k) => kinds.has(k));
  // A hilly race: hill reps come round more often in the build and race-specific weeks.
  const el = courseElevation(o.terrain, DIST_M[o.dist] / 1000);
  if (el.gain / (DIST_M[o.dist] / 1000) >= 8 && (phase === "build" || phase === "specific") && prefs.includes("hills")) prefs = (["hills", ...prefs.filter((k) => k !== "hills")] as SessionKind[]).slice(0, 4);
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
    // Each kind steps through its variations in turn, so the same session doesn't come round again for weeks.
    const v = seen.get(k) ?? 0;
    seen.set(k, v + 1);
    const q = session(k, v, o, phase, t, p, race);
    out.push(KIND_LABEL[k] && !q.whole ? { ...q, text: `${KIND_LABEL[k]}: ${q.text}` } : q);
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
  if (o.goal === "start") return buildStartPlan(old, o, h, today);
  if (o.goal === "beyond5k") return buildBeyond5kPlan(old, o, h, today);
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
  const v0 = h.vdot ?? (o.level === "beginner" ? 32 : 42);
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
  // Race-specific weeks (not the easier ones), so long runs can alternate: big, shorter, big, …
  // (Weeks with a tune-up race don't count: their long run makes way for the race.)
  const raceWeeks = new Set(
    [...(o.keepRaces ? old.races : []), ...(o.extraRaces ?? [])].filter((r) => r.date && !r.approx && r.date >= start && r.date < o.raceDate).map((r) => mondayOf(r.date!)),
  );
  const specWeeks: number[] = [];
  for (let i = 0; i < N; i++) if (i >= buildN - specN && i < buildN && !(i > 0 && (i + 1) % L.cutEvery === 0 && i < buildN - 1) && !raceWeeks.has(addDays(start, i * 7))) specWeeks.push(i);
  /** Share of the longest run for a race-specific week: the biggest last (counting back), every other week a clearly shorter one. */
  const specShare = (i: number) => {
    const back = specWeeks.length - 1 - specWeeks.indexOf(i);
    return back % 2 === 0 ? 1 - 0.04 * (back / 2) : 0.8 - 0.015 * ((back - 1) / 2);
  };
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
      // Race-specific weeks: long runs towards the cap, but only every other one at full length (like Pfitzinger's or Runna's
      // plans): the longest comes a few weeks before the taper, with shorter long runs (and medium-long runs) between.
      const want = Math.min(L.longCap[o.dist], phase === "specific" && isRace ? Math.max(km * frac * 0.85, L.longCap[o.dist] * Math.max(0.68, specShare(i))) : phase === "recover" ? km * 0.28 : km * frac);
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
    priority: "A",
    ...(o.terrain ? { elevation: { ...courseElevation(o.terrain, DIST_M[o.dist] / 1000), kind: o.terrain.kind } } : {}),
  };
  const inside = old.races.filter((r) => r.date && !r.approx && r.date >= start && r.date <= end && r.date !== o.raceDate);
  // Tune-ups get the taper you chose for them (Races), else one that fits how much they matter; applied when the plan loads.
  const added = (o.extraRaces ?? []).filter((r) => r.date && r.date >= start && r.date < o.raceDate && !inside.some((x) => x.date === r.date && x.name === r.name));
  const tuneUps = [...(o.keepRaces ? inside : []), ...added].map((r) => ({ ...r, taper: r.taper ?? (priorityOf(r) === "A" || priorityOf(r) === "B" ? ("mini" as const) : ("none" as const)) }));

  // Write each week day by day.
  const longDay: DayKey = o.longDay;
  const by = longDay === "sat" ? -1 : 0;
  const run = (PATTERN[o.days] ?? PATTERN[5]).map((k) => shift(k, by));
  const q1 = shift("tue", by);
  const q2 = o.days >= 4 ? shift("thu", by) : null;
  const seen = new Map<SessionKind, number>();
  // Race-specific weeks, numbered (marathon pace goes in every other long run, not all of them).
  const specIdx = (i: number) => built.slice(0, i).filter((x) => x.phase === "specific" && !x.cut).length;
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
      // Marathon pace in the long run every other race-specific week; the weeks between keep MP for one session.
      longHard = withMp > 0 && b.long >= 20 && (T.mpLong === true || specIdx(i) % 2 === 0);
      if (lastFaster) {
        // The block ends with a time trial: see what you've gained.
        s[longDay] = `${WARM + 5} km with 5 km time trial: 5 km at ${around(p.fivek)}`;
        sized[longDay] = WARM + 5;
      } else {
        let text = `${b.long} km long run`;
        if (longHard) {
          // Race practice: marathon pace inside the long run, as a finish or in blocks (they alternate).
          const blocks = Math.max(2, Math.min(4, Math.round(withMp / 5)));
          text = i % 4 === 1 && b.long >= 26 ? `${b.long} km long run with ${blocks} × 5 km at MP ${around(rp, 3)}, 4 min easy` : `${b.long} km long run, last ${withMp} at MP ${around(rp, 3)}`;
        } else if (isRace && o.dist === "half" && b.phase === "specific" && !b.cut && alt && T.mpLong !== false) {
          text = `${b.long} km long run, last ${r1(lerp(4, 8, t))} at HMP ${around(rp, 3)}`;
        } else if (isRace && b.phase === "build" && !b.cut && i % 2 === 0 && b.long >= 16 && T.mpLong !== false) {
          // Build weeks: every other long run finishes a little quicker, to practise running strong when tired.
          text = `${b.long} km long run, last ${r1(lerp(3, 5, t))} at ${around(o.dist === "marathon" ? rp + 8 : p.mp, 3)}`;
        }
        // Long runs late in the plan on ground like the race's.
        const el = courseElevation(o.terrain, DIST_M[o.dist] / 1000);
        const perKm = el.gain / (DIST_M[o.dist] / 1000);
        if (isRace && (b.phase === "specific" || b.phase === "build") && perKm >= 4) text += perKm >= 8 ? " on a hilly route" : " on rolling roads";
        s[longDay] = text;
        sized[longDay] = b.long;
      }
    }
    // Marathon pace in the long run makes it a hard day: one session fewer, and no race-pace session on top.
    if (longHard) {
      nQ = Math.max(0, nQ - 1);
      kinds.delete("racepace");
    }
    let picks = pickSessions(nQ, qPhase, i, kinds, o, t, p, rp, seen);
    // Before the race-specific weeks, a tune-up week keeps a short threshold session rather than race-pace work.
    if (tune && (b.phase === "base" || b.phase === "build") && picks.length) picks = [{ ...reps(4, 1, p.threshold, "90 s jog", 90), kind: "threshold" as const }].map((q) => ({ ...q, text: `Threshold: ${q.text}` }));
    // Periodised around tune-ups: the two weeks before a B race sharpen for it, one session at its pace.
    const nextTune = T.sharpen === false ? null : tuneUps.find((r) => priorityOf(r) === "B" && r.date! > addDays(b.monday, 6) && r.date! <= addDays(b.monday, 20));
    let sharpenFor: string | null = null;
    if (nextTune && (b.phase === "base" || b.phase === "build") && !b.cut && picks.length) {
      const k = nextTune.km ?? raceKm(nextTune.name) ?? 10;
      const q = k <= 6 ? { ...reps(5, 1, p.fivek, "2 min jog", 120), label: "5K pace" } : k <= 12 ? { ...reps(4, 2, p.tenk, "90 s jog", 90), label: "10K pace" } : k <= 25 ? { ...hmp(reps(3, 4, p.hmp, "2 min jog", 120)), label: "Half pace" } : null;
      if (q) {
        picks[0] = { km: q.km, text: `${q.label}: ${q.text}`, kind: "racepace" };
        sharpenFor = nextTune.name;
      }
    }
    // Quality days: Tuesday and Thursday (shifted for a Saturday long run); a third on the day before the long run.
    const qDays = [q1, q2, o.days >= 6 ? shift(longDay, -1) : null];
    picks.forEach((q, j) => {
      const d = qDays[j];
      if (!d || raceDays.has(d) || near(d) || s[d]) return;
      s[d] = q.whole ? q.text : withWarmUp(q);
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
    // Doubles: a short easy second run on easy days (then quality days), not around the long run or a race.
    const pm: Partial<Record<DayKey, number>> = {};
    const nD = b.phase === "base" || b.phase === "build" || b.phase === "specific" ? (b.cut ? Math.min(1, T.doubles ?? 0) : (T.doubles ?? 0)) : 0;
    if (nD > 0) {
      const pmKm = r1(Math.max(5, Math.min(8, km * 0.065)));
      const bad = (k: DayKey) => raceDays.has(k) || near(k) || k === longAt || (longAt != null && Math.min(Math.abs(IDX(k) - IDX(longAt)), 7 - Math.abs(IDX(k) - IDX(longAt))) === 1) || !run.includes(k);
      const easyFirst = [...run.filter((k) => !s[k]), q1, q2].filter((k): k is DayKey => !!k && !bad(k));
      for (const k of [...new Set(easyFirst)].slice(0, nD)) pm[k] = pmKm;
    }
    // Easy days take what's left of the week.
    const easy = run.filter((k) => !s[k]);
    const used = Object.values(sized).reduce((a, x) => a + (x ?? 0), 0) + Object.values(pm).reduce((a, x) => a + (x ?? 0), 0);
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
    for (const [k, v] of Object.entries(pm) as [DayKey, number][]) {
      if (!s[k]) continue;
      s[k] = `${s[k]} · PM: ${v} km easy`;
      sized[k] = (sized[k] ?? 0) + v;
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
            : sharpenFor
              ? `Sharpening for ${sharpenFor}: one session at its pace, the rest as planned.`
            : isRace && b.phase === "specific" && (() => {
                  const el = courseElevation(o.terrain, DIST_M[o.dist] / 1000);
                  return el.loss - el.gain > 150;
                })()
              ? "The race drops a lot: run some easy runs and the long run downhill to get your quads used to it."
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
/** Sessions that rehearse the race (race pace, race-practice long runs, time trials), for highlighting. */
/**
 * What a session trains, for plans written without labels: threshold (T, tempo, longer reps), VO2 max
 * (short reps at speed), fartlek, hills. Null for easy and long runs, and when the text already says.
 */
export function sessionKindOf(text: string): string | null {
  if (/\b(VO2 max|Threshold|Threshold tempo|Hill strength|Race pace|5K pace|10K pace|Half pace):/i.test(text) || /fartlek/i.test(text)) return null;
  if (/hill (?:reps|repeats)/i.test(text)) return "Hill strength";
  if (/\bT\b|threshold|tempo|cruise/i.test(text)) return "Threshold";
  const rep = /(\d+)\s*×\s*(\d+(?:\.\d+)?)\s*(km|m|min|s)\b[^,]*\bat\s+(?!MP|HMP)/i.exec(text);
  if (rep) {
    const [, , size, unit] = rep;
    const metres = unit === "km" ? +size * 1000 : unit === "m" ? +size : null;
    const secs = unit === "min" ? +size * 60 : unit === "s" ? +size : null;
    if ((metres != null && metres <= 1200) || (secs != null && secs <= 240)) return "VO2 max";
    return "Threshold";
  }
  return null;
}

export function practiceOf(text: string): "Race practice" | "Fast finish" | null {
  if (/race practice|time trial|\b(?:MP|HMP)\b/i.test(text)) return "Race practice";
  if (/fast finish|progression run|long run, last \d+ at/i.test(text)) return "Fast finish";
  return null;
}

export function expectedGain(weeks: number, level: Level): number {
  const cap = level === "beginner" ? 6 : level === "intermediate" ? 5 : 4.5;
  return cap * (1 - Math.exp(-weeks / 30));
}

const nQText = (o: BuildOptions) =>
  (o.tune?.quality ?? LEVELS[o.level].quality) >= 2 && o.days >= 4
    ? "Two quality sessions a week (one in easier, tune-up and taper weeks): threshold and VO2 max work early, race-pace work late."
    : "One quality session a week, alternating threshold, VO2 max and race-pace work.";

// ---- Start running: walk and run to 30 minutes ------------------------------------------

/** One session of the run/walk programme: [run minutes, walk minutes] pairs, done in order. */
type RunWalk = { reps: number; run: number; walk: number }[];
/** Nine weeks from one minute of running at a time to 30 minutes without stopping (like Couch to 5K). */
const START_WEEKS: { s: RunWalk; note: string }[] = [
  { s: [{ reps: 8, run: 1, walk: 1.5 }], note: "Run slowly enough to talk. Walking is part of the plan, not a failure." },
  { s: [{ reps: 6, run: 1.5, walk: 2 }], note: "A little more running each time. Keep the running gentle." },
  { s: [{ reps: 2, run: 1.5, walk: 1.5 }, { reps: 2, run: 3, walk: 3 }], note: "Three-minute runs this week: slow down rather than stop." },
  { s: [{ reps: 2, run: 3, walk: 1.5 }, { reps: 2, run: 5, walk: 2.5 }], note: "Five-minute runs. If a week felt hard, repeat it: there's no rush." },
  { s: [{ reps: 3, run: 5, walk: 3 }], note: "Halfway. Three blocks of five minutes." },
  { s: [{ reps: 2, run: 8, walk: 3 }], note: "Eight minutes at a time. Same easy pace as week one." },
  { s: [{ reps: 2, run: 12, walk: 2 }], note: "Twelve-minute runs with a short walk between." },
  { s: [{ reps: 1, run: 20, walk: 0 }], note: "Twenty minutes without stopping. Go slower than you think." },
  { s: [{ reps: 1, run: 30, walk: 0 }], note: "Thirty minutes of running. That's the goal: you're a runner." },
];
/** Beginner speeds for an estimate of distance: running about 7:30/km, brisk walking about 11:00/km. */
const RW_RUN = 7.5;
const RW_WALK = 11;
const fmtMin = (m: number) => (m < 1 || m % 1 ? `${Math.round(m * 60)} s` : `${m} min`);

function startSession(rw: RunWalk, last: boolean): { text: string; km: number; mins: number } {
  // A 5-minute brisk walk to warm up and another to cool down, around the running.
  const runMin = rw.reduce((a, b) => a + b.reps * b.run, 0);
  const walkMin = rw.reduce((a, b) => a + b.reps * b.walk, 0) + 10;
  const km = Math.round((runMin / RW_RUN + walkMin / RW_WALK) * 2) / 2;
  const mins = Math.round(runMin + walkMin);
  if (rw.length === 1 && rw[0].reps === 1 && rw[0].walk === 0) {
    return { text: `${km} km easy: ${rw[0].run} min run without stopping${last ? " (your goal!)" : ""}, 5 min walk before and after`, km, mins };
  }
  const parts = rw.map((b) => `${b.reps} × ${fmtMin(b.run)} run, ${fmtMin(b.walk)} walk`).join(", then ");
  return { text: `${km} km run/walk: ${parts}; 5 min walk before and after`, km, mins };
}

/** A beginner's plan: three run/walk sessions a week, building to 30 minutes of running. No race or 5k time needed. */
export function buildStartPlan(old: Plan, o: BuildOptions, h: History, today: string): { plan: Plan; weeks: BuiltWeek[] } {
  const firstAllowed = mondayOf(today) < today ? addDays(mondayOf(today), 7) : mondayOf(today);
  const N = Math.max(3, Math.min(20, o.weeks || START_WEEKS.length));
  const start = firstAllowed;
  const end = addDays(start, N * 7 - 1);
  // Runs on three days with a rest day between; the third on your long-run day. Other days: rest or a walk.
  const runDays: DayKey[] = o.longDay === "sat" ? ["mon", "wed", "sat"] : ["tue", "thu", "sun"];
  const walkDays = o.days >= 4 ? WEEK_KEYS.filter((k) => !runDays.includes(k)).slice(0, o.days - 3) : [];
  const built: BuiltWeek[] = [];
  const weeks: PlanWeek[] = [];
  for (let i = 0; i < N; i++) {
    // Longer than nine weeks: each step lasts a little longer. Shorter: some steps are skipped.
    const step = START_WEEKS[Math.min(START_WEEKS.length - 1, Math.floor((i * START_WEEKS.length) / N))];
    const lastWeek = i === N - 1;
    const sess = startSession(step.s, lastWeek);
    const monday = addDays(start, i * 7);
    const s: Partial<Record<DayKey, string>> = {};
    for (const k of WEEK_KEYS) s[k] = runDays.includes(k) ? sess.text : walkDays.includes(k) ? "Rest (or a 20–30 min walk)" : "Rest";
    const km = Math.round(sess.km * 3 * 10) / 10;
    built.push({ monday, phase: "base", km, long: sess.km, cut: false });
    weeks.push({
      week: String(i + 1),
      start: monday,
      end: addDays(monday, 6),
      phase: i < Math.ceil(N * 0.55) ? "Run/walk" : "Running",
      km: String(km),
      kmMin: km,
      kmMax: km,
      sessions: s,
      notes: step.note,
    });
  }
  const runWalkEnd = weeks.filter((w) => w.phase === "Run/walk").length;
  const phases: Plan["phases"] = [
    { name: "Run/walk", start, end: addDays(start, runWalkEnd * 7 - 1), summary: "Short runs with walks between, three times a week. The runs get longer and the walks shorter." },
    ...(runWalkEnd < N ? [{ name: "Running", start: addDays(start, runWalkEnd * 7), end, summary: "Longer runs with fewer walks, to 30 minutes of running without stopping." }] : []),
  ];
  const v0 = Math.min(h.vdot ?? 28, 34);
  const p = pacesFor(v0);
  const zone = (z: string, a: string, use: string) => ({ zone: z, now: a, autumn: a, hr: "", use });
  const paces: Plan["paces"] = [
    zone("Easy", range(...p.easy), "Your running: slow enough to talk in full sentences"),
    zone("Walk", "Brisk", "Between runs, and 5 minutes before and after"),
  ];
  const rules = [
    "Run slowly: you should be able to talk in full sentences. If you can't, slow down or walk.",
    "Three sessions a week with a rest day between. Rest days are when your body adapts.",
    "A week felt hard? Do it again before moving on. There's no prize for finishing early.",
    "Sore for more than a couple of days, or anything sharp or getting worse? Rest, and see someone if it doesn't settle.",
    "Good running shoes help. Time, not distance, is what counts for now: the distances are estimates.",
  ];
  const keepBefore = old.weeks.filter((w) => w.end < start);
  const keepAfter = old.weeks.filter((w) => w.start > end);
  const { previous: _p, baseWeeks: _b, prefs: _q, hrZones: _h, ...prev } = old;
  const peak = Math.max(...built.map((b) => b.km));
  const longest = Math.max(...built.map((b) => b.long));
  const plan: Plan = {
    ...old,
    title: `Start running: ${N} weeks`,
    source: `Built in the app on ${fmtDay(today)} ${new Date(today).getFullYear()}`,
    exported: today,
    phases: [...old.phases.filter((x) => x.end && x.end < start), ...phases, ...old.phases.filter((x) => x.start && x.start > end)],
    blocks: old.blocks.filter((b) => !b.start || b.start > end || (b.end && b.end < start)),
    races: old.races.filter((r) => !r.date || r.date < start || r.date > end),
    weeks: [...keepBefore, ...weeks, ...keepAfter],
    paces,
    structure: old.structure,
    rules,
    benchmarks: old.benchmarks.filter((b) => !b.date || b.date < start || b.date > end),
    adjust: null,
    baseWeeks: undefined,
    built: { ...o, goal: "start", level: "beginner", weeks: N, raceDate: end, start, peak, longest, vdot: v0, vdotEnd: v0 },
    previous: prev,
  };
  return { plan, weeks: built };
}

// ---- Beyond 5k: for someone who runs 5k (in about 30–40 min) and wants more -----------------

/**
 * Ten weeks, three runs (a fourth short easy one if you want it): an easy run, one session that
 * rotates between fartlek, hills, "comfortably hard" blocks and 5k-pace reps, and a long run that grows
 * from 5 to 8–9 km. Every fourth week is easier. The last week ends with a 5k time trial.
 */
type B5Session = (p: Paces) => { km: number; text: string };
const B5_SESSIONS: B5Session[] = [
  () => ({ km: 4.5, text: "4.5 km fartlek: 6 × 1 min brisk, 2 min easy" }),
  () => ({ km: 4, text: "4 km with 8 × 30 s up a gentle hill, walk or jog back down" }),
  (p) => ({ km: 5, text: `5 km with 3 × 5 min comfortably hard (T, ${around(p.threshold + 10)}), 2 min easy` }),
  () => ({ km: 4, text: "4 km easy + 4 × 20 s strides" }),
  () => ({ km: 5, text: "5 km fartlek: 8 × 1 min brisk, 1 min easy" }),
  (p) => ({ km: 5.5, text: `5.5 km with 2 × 8 min comfortably hard (T, ${around(p.threshold + 10)}), 3 min easy` }),
  (p) => ({ km: 5.5, text: `5.5 km with 5 × 3 min at 5k pace (${around(p.fivek)}), 2 min jog or walk` }),
  () => ({ km: 4.5, text: "4.5 km fartlek: 5 × 1 min brisk, 2 min easy" }),
  (p) => ({ km: 6, text: `6 km with 3 × 8 min comfortably hard (T, ${around(p.threshold + 10)}), 2 min easy` }),
  (p) => ({ km: 4, text: `4 km with 4 × 1 min at 5k pace (${around(p.fivek)}), 2 min easy` }),
];
/** Long run and easy run, km, week by week (weeks 4 and 8 easier). */
const B5_LONG = [5, 5.5, 6, 5, 6.5, 7, 8, 6, 9, 0];
const B5_EASY = [3.5, 4, 4, 3.5, 4.5, 4.5, 5, 4, 5, 3];
const B5_CUT = new Set([3, 7]);

export function buildBeyond5kPlan(old: Plan, o: BuildOptions, h: History, today: string): { plan: Plan; weeks: BuiltWeek[] } {
  const firstAllowed = mondayOf(today) < today ? addDays(mondayOf(today), 7) : mondayOf(today);
  const N = Math.max(4, Math.min(20, o.weeks || B5_LONG.length));
  const start = firstAllowed;
  const end = addDays(start, N * 7 - 1);
  // Paces from the 5k time you give (or your running); about 35 min if neither is known.
  const tSec = o.target ? targetTime(o.target, 5000) : null;
  const v0 = Math.min(45, Math.max(20, tSec ? vdotOf(5000, tSec) : (h.vdot ?? vdotOf(5000, 35 * 60))));
  const vEnd = v0 + Math.min(2.5, N * 0.25);
  const sat = o.longDay === "sat";
  const sessDay: DayKey = sat ? "tue" : "tue";
  const easyDay: DayKey = sat ? "thu" : "thu";
  const longDay: DayKey = o.longDay;
  const extraDay: DayKey | null = o.days >= 4 ? (sat ? "mon" : "sat") : null;
  const built: BuiltWeek[] = [];
  const weeks: PlanWeek[] = [];
  for (let i = 0; i < N; i++) {
    const j = Math.min(B5_LONG.length - 1, Math.floor((i * B5_LONG.length) / N));
    const last = i === N - 1;
    const p = pacesFor(lerp(v0, vEnd, i / Math.max(1, N - 1)));
    const q = B5_SESSIONS[j](p);
    const easyKm = B5_EASY[j];
    const s: Partial<Record<DayKey, string>> = {};
    const sized: Partial<Record<DayKey, number>> = {};
    for (const k of WEEK_KEYS) s[k] = "Rest";
    s[sessDay] = q.text;
    sized[sessDay] = q.km;
    s[easyDay] = `${easyKm} km easy`;
    sized[easyDay] = easyKm;
    if (last) {
      s[longDay] = `7 km with 5 km time trial: as fast as you can hold evenly (about ${fmtPace(p.fivek)}/km), 1 km easy before and after`;
      sized[longDay] = 7;
    } else {
      s[longDay] = `${B5_LONG[j]} km long run`;
      sized[longDay] = B5_LONG[j];
    }
    if (extraDay && !B5_CUT.has(j) && !last) {
      s[extraDay] = "3 km easy (optional)";
      sized[extraDay] = 3;
    }
    const km = Math.round(Object.values(sized).reduce((a, x) => a + (x ?? 0), 0) * 10) / 10;
    const cut = B5_CUT.has(j);
    built.push({ monday: addDays(start, i * 7), phase: last ? "race" : "base", km, long: last ? 7 : B5_LONG[j], cut });
    weeks.push({
      week: String(i + 1),
      start: addDays(start, i * 7),
      end: addDays(start, i * 7 + 6),
      phase: last ? "Time trial" : i < N / 2 ? "Building" : "Stronger",
      km: String(km),
      kmMin: km,
      kmMax: km,
      sessions: s,
      notes: last
        ? "Time trial week: an easy start to the week, then run 5 km as fast as you can hold evenly. Compare it with where you started."
        : cut
          ? "Easier week: a bit less running so the last three weeks sink in."
          : i === 0
            ? "Easy runs really easy: you should be able to chat. The session is the one day to work a bit."
            : "",
    });
  }
  const half = Math.ceil(N / 2);
  const phases: Plan["phases"] = [
    { name: "Building", start, end: addDays(start, half * 7 - 1), summary: "Three runs a week: easy, a short fun session (fartlek, hills, comfortably hard), and a long run from 5 km up." },
    { name: "Stronger", start: addDays(start, half * 7), end: addDays(start, (N - 1) * 7 - 1), summary: "Longer blocks at comfortably hard and some 5k-pace reps; the long run reaches 8–9 km." },
    { name: "Time trial", start: addDays(start, (N - 1) * 7), end, summary: "A lighter week ending with a 5 km time trial." },
  ];
  // At this fitness the formula's easy pace is close to walking; easy here is about 1¼–2¼ min/km slower than 5k pace.
  const relax = (q: Paces): Paces => ({ ...q, easy: [q.fivek + 75, q.fivek + 135], long: [q.fivek + 70, q.fivek + 125] });
  const p0 = relax(pacesFor(v0));
  const p1 = relax(pacesFor(vEnd));
  const zone = (z: string, a: string, b: string, use: string) => ({ zone: z, now: a, autumn: b, hr: "", use });
  const paces: Plan["paces"] = [
    zone("Easy", range(...p0.easy), range(...p1.easy), "Most of your running: you can talk in sentences"),
    zone("Long run (easy part)", range(...p0.long), range(...p1.long), "Long runs"),
    zone("Threshold (T)", around(p0.threshold + 10), around(p1.threshold + 10), "Comfortably hard: a few words at a time"),
    zone("5k pace", around(p0.fivek), around(p1.fivek), "5k-pace reps and the time trial"),
    zone("Brisk (fartlek)", "By feel", "By feel", "Faster than easy, relaxed, never a sprint"),
  ];
  const rules = [
    `Easy runs at ${range(...p0.easy)}/km or slower: easy is the most important pace in the plan.`,
    "One session a week, on fresh legs, with a rest day or easy day either side.",
    "The long run grows about half a kilometre a week. Walk breaks are fine whenever you need them.",
    "Every fourth week is easier. Tired, sore or ill? Skip the session and run easy, or rest.",
    `Paces come from your 5k (VDOT ${v0.toFixed(1)}); the time trial at the end shows how far you've come.`,
  ];
  const keepBefore = old.weeks.filter((w) => w.end < start);
  const keepAfter = old.weeks.filter((w) => w.start > end);
  const { previous: _p, baseWeeks: _b, prefs: _q, hrZones: _h, ...prev } = old;
  const peak = Math.max(...built.map((b) => b.km));
  const longest = Math.max(...built.map((b) => b.long));
  const plan: Plan = {
    ...old,
    title: `Beyond 5k: ${N} weeks`,
    source: `Built in the app on ${fmtDay(today)} ${new Date(today).getFullYear()}`,
    exported: today,
    phases: [...old.phases.filter((x) => x.end && x.end < start), ...phases, ...old.phases.filter((x) => x.start && x.start > end)],
    blocks: old.blocks.filter((b) => !b.start || b.start > end || (b.end && b.end < start)),
    races: old.races.filter((r) => !r.date || r.date < start || r.date > end),
    weeks: [...keepBefore, ...weeks, ...keepAfter],
    paces,
    structure: old.structure,
    rules,
    benchmarks: old.benchmarks.filter((b) => !b.date || b.date < start || b.date > end),
    adjust: null,
    baseWeeks: undefined,
    built: { ...o, goal: "beyond5k", level: "beginner", dist: "5k", weeks: N, raceDate: end, start, peak, longest, vdot: v0, vdotEnd: vEnd },
    previous: prev,
  };
  return { plan, weeks: built };
}
