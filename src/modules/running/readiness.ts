import { addDays, diffDays } from "../../core/time";
import { shapeFactor } from "./fitness";
import { forecastWeek, raceKm, type ForecastDay } from "./forecast";
import { mondayOf, priorityOf, type Plan, type PlanRace } from "./plan";
import { elevationCost, expectedGain } from "./planBuilder";
import { predictTime } from "./vo2";

/**
 * Race readiness: how well a plan (followed from today) prepares you for a
 * race. Five parts: weekly volume and long runs against what the distance
 * needs at your fitness, race-specific sessions, the taper, and how safely
 * the mileage builds. Works for any plan: the one in the app, one built here,
 * or one imported from a CSV.
 */

export interface ReadinessPart {
  key: "volume" | "long" | "specific" | "taper" | "ramp";
  label: string;
  pct: number;
  note: string;
}
export interface Readiness {
  score: number;
  parts: ReadinessPart[];
  /** Predicted time on the day (s), from fitness on race day and how ready the plan gets you. */
  predicted: number | null;
  /** Race-day range (s): fast end if training goes to plan and fitness responds well, slow end if it only partly does. */
  range: [number, number] | null;
  /** If you raced today: today's fitness and your last 8 weeks of actual running. */
  now: number | null;
  goal: number | null;
  distanceKm: number;
  /** The same check on what you've actually run in the last 8 weeks: ready if the race were today. */
  today: { score: number; parts: ReadinessPart[] };
}

const WEIGHTS: Record<ReadinessPart["key"], number> = { volume: 0.35, long: 0.25, specific: 0.2, taper: 0.1, ramp: 0.1 };
const interp = (pts: [number, number][], x: number) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++)
    if (x <= pts[i][0]) return pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * (x - pts[i - 1][0])) / (pts[i][0] - pts[i - 1][0]);
  return pts[pts.length - 1][1];
};

export function raceDistance(r: Pick<PlanRace, "name" | "km">): number {
  return r.km ?? raceKm(r.name) ?? 10;
}

/** Weekly km and long run a race of this distance needs at a fitness (VDOT). */
export function needsFor(km: number, vdot: number) {
  const marathonKm = interp([[25, 39], [50, 85], [70, 124]], vdot);
  const marathonLong = interp([[25, 22], [50, 30], [70, 34]], vdot);
  const share = km >= 40 ? 1 : km >= 20 ? 0.7 : km >= 9 ? 0.55 : 0.45;
  const longShare = km >= 40 ? 1 : km >= 20 ? 0.62 : km >= 9 ? 0.48 : 0.4;
  return { km: marathonKm * share, long: Math.max(km >= 40 ? 0 : km >= 20 ? 16 : km >= 9 ? 12 : 10, marathonLong * longShare) };
}

const SPECIFIC: [number, RegExp][] = [
  [40, /\bMP\b|marathon pace/i],
  [20, /\bHMP\b|half/i],
  [9, /10k|\d\s*×\s*(?:[12](?:\.\d)?\s*km|1[02]00\s*m)/i],
  [0, /5k|\d\s*×\s*(?:[0-9]00\s*m|1\s*km)/i],
];

interface WeekLook {
  monday: string;
  km: number;
  longest: number;
  days: ForecastDay[];
}

/** Fitness (VDOT) on a date; may carry Garmin's predicted time for a distance, which then sets "now". */
export type VdotAt = ((date: string) => number | null) & { garmin?: (meters: number) => number | null };

/**
 * Garmin's predicted time at any distance, from its 5K / 10K / half / marathon predictions:
 * between two of them along their own curve (time ∝ distance^k), beyond them along the nearest pair's.
 */
export function garminTimeAt(values: Record<string, number>, meters: number): number | null {
  const pts = (
    [
      [5000, values["5k"]],
      [10000, values["10k"]],
      [21097.5, values["Half"]],
      [42195, values["Marathon"]],
    ] as [number, number | undefined][]
  ).filter((p): p is [number, number] => !!p[1] && p[1] > 0);
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0][1] * Math.pow(meters / pts[0][0], 1.06);
  let i = pts.findIndex((p) => p[0] >= meters);
  if (i <= 0) i = i === 0 ? 1 : pts.length - 1;
  const [d1, t1] = pts[i - 1];
  const [d2, t2] = pts[i];
  const k = Math.log(t2 / t1) / Math.log(d2 / d1);
  return t1 * Math.pow(meters / d1, k);
}

export function raceReadiness(
  plan: Plan,
  race: Pick<PlanRace, "date" | "name" | "km" | "target" | "elevation"> & Partial<Pick<PlanRace, "priority" | "role">>,
  today: string,
  vdotAt: VdotAt,
  actual: Map<string, number> = new Map(),
): Readiness | null {
  if (!race.date) return null;
  const km = raceDistance(race);
  const v = vdotAt(race.date) ?? vdotAt(today);
  if (v == null) return null;
  const need = needsFor(km, v);
  const raceMon = mondayOf(race.date);
  // Weeks up to the race: what you ran (past days) and what the plan has (from today).
  const weeks: WeekLook[] = [];
  for (let i = 12; i >= 0; i--) {
    const monday = addDays(raceMon, -7 * i);
    const f = forecastWeek(plan, monday);
    const days = f.days;
    let total = 0;
    let longest = 0;
    for (const d of days) {
      if (d.race || d.kind === "race") continue;
      const k = d.date < today ? actual.get(d.date) ?? 0 : d.km ?? 0;
      total += k;
      longest = Math.max(longest, k);
    }
    weeks.push({ monday, km: total, longest, days });
  }
  const build = weeks.slice(0, 11); // up to two weeks before race week
  const window = build.slice(-8);
  const avg = window.reduce((s, w) => s + w.km, 0) / window.length;
  const longest = Math.max(...window.map((w) => w.longest));
  const pct = (x: number) => Math.max(0, Math.min(100, Math.round(x)));

  const volume = pct((avg / need.km) * 100);
  const long = pct((longest / need.long) * 100);
  const re = SPECIFIC.find(([k]) => km >= k)![1];
  // Marathon: long runs with a faster section ("33 km, 16 at 3:58") count as race-specific too.
  // A B or C race is a tune-up inside another build: any quality session sharpens you for it,
  // and it gets a short taper at most, so it isn't judged like a goal race.
  // (A standard distance you're looking at, not one of your races, has no role: judged as a goal race.)
  const tuneUp = race.role !== undefined || race.priority ? priorityOf(race as PlanRace) !== "A" : false;
  const isSpecific = (d: ForecastDay) => re.test(d.text) || (km >= 40 && d.kind === "long" && /\bat\s+\d:\d\d/.test(d.text)) || (tuneUp && d.kind === "key" && /\bat\s+\d:\d\d|\bT\b|threshold|tempo|×/i.test(d.text));
  const specificDays = weeks.slice(-10, -1).flatMap((w) => w.days.filter((d) => (d.kind === "key" || d.kind === "long") && isSpecific(d)));
  const wantSpecific = tuneUp ? 4 : km >= 20 ? 5 : 6;
  const specific = pct((specificDays.length / wantSpecific) * 100);
  const peak = Math.max(...build.slice(-6).map((w) => w.km), 1);
  const raceWeek = weeks[weeks.length - 1].km / peak;
  const prevWeek = weeks[weeks.length - 2].km / peak;
  const [rwOk, pwOk] = (km >= 40 ? [0.6, 0.85] : km >= 20 ? [0.75, 0.95] : [0.85, 1.05]).map((x) => (tuneUp ? x + 0.2 : x));
  const taper = pct(100 - Math.max(0, raceWeek - rwOk) * 200 - Math.max(0, prevWeek - pwOk) * 150);
  let jump = 0;
  for (let i = 1; i < build.length; i++) {
    const a = build[i - 1].km;
    const b = build[i].km;
    // Coming back from an easier week isn't a jump.
    const ref = Math.max(a, i >= 2 ? build[i - 2].km : 0, i >= 3 ? build[i - 3].km : 0);
    if (ref >= 20) jump = Math.max(jump, b / ref - 1);
  }
  const ramp = pct(jump <= 0.12 ? 100 : jump <= 0.25 ? 100 - ((jump - 0.12) / 0.13) * 50 : 50 - Math.min(40, (jump - 0.25) * 200));

  const parts: ReadinessPart[] = [
    { key: "volume", label: "Weekly volume", pct: volume, note: `${Math.round(avg)} km a week in the 8 weeks before the taper; this race needs about ${Math.round(need.km)} at your fitness.` },
    { key: "long", label: "Long runs", pct: long, note: `Longest ${Math.round(longest)} km; about ${Math.round(need.long)} km is what this distance asks for.` },
    {
      key: "specific",
      label: "Race-specific work",
      pct: specific,
      note: tuneUp
        ? `${specificDays.length} quality session${specificDays.length === 1 ? "" : "s"} in the last 9 weeks (${wantSpecific}+ is plenty). It's a tune-up, so the speed work for your main race counts.`
        : `${specificDays.length} session${specificDays.length === 1 ? "" : "s"} at or around race pace in the last 9 weeks (${wantSpecific}+ is ideal).`,
    },
    {
      key: "taper",
      label: "Taper",
      pct: taper,
      note: `Race week is ${Math.round(raceWeek * 100)}% and the week before ${Math.round(prevWeek * 100)}% of your peak (around ${Math.round(rwOk * 100)}% and ${Math.round(pwOk * 100)}% or less is ideal).`,
    },
    {
      key: "ramp",
      label: "Safe build",
      pct: ramp,
      note: jump > 0.12 ? `Biggest jump: ${Math.round(jump * 100)}% in a week (10–12% is safe).` : "Mileage never jumps more than about 10% a week.",
    },
  ];
  const score = Math.round(parts.reduce((s, p) => s + p.pct * WEIGHTS[p.key], 0));

  // Ready today: your actual last 8 weeks (no taper, so the other parts share its weight).
  const thisMon = mondayOf(today);
  const past: WeekLook[] = [];
  for (let i = 8; i >= 1; i--) {
    const monday = addDays(thisMon, -7 * i);
    const days = forecastWeek(plan, monday).days;
    let total = 0;
    let longest = 0;
    for (let k = 0; k < 7; k++) {
      const x = actual.get(addDays(monday, k)) ?? 0;
      total += x;
      longest = Math.max(longest, x);
    }
    past.push({ monday, km: total, longest, days });
  }
  const tAvg = past.reduce((a, w) => a + w.km, 0) / past.length;
  const tLong = Math.max(...past.map((w) => w.longest));
  const tSpecific = past.flatMap((w) => w.days.filter((d) => (d.kind === "key" || d.kind === "long") && isSpecific(d) && (actual.get(d.date) ?? 0) > 0)).length;
  let tJump = 0;
  for (let i = 1; i < past.length; i++) {
    const ref = Math.max(past[i - 1].km, i >= 2 ? past[i - 2].km : 0, i >= 3 ? past[i - 3].km : 0);
    if (ref >= 20) tJump = Math.max(tJump, past[i].km / ref - 1);
  }
  const todayParts: ReadinessPart[] = [
    { key: "volume", label: "Weekly volume", pct: pct((tAvg / need.km) * 100), note: `${Math.round(tAvg)} km a week over your last 8 weeks; this race needs about ${Math.round(need.km)}.` },
    { key: "long", label: "Long runs", pct: pct((tLong / need.long) * 100), note: `Longest ${Math.round(tLong)} km in the last 8 weeks; about ${Math.round(need.long)} km is what this distance asks for.` },
    { key: "specific", label: "Race-specific work", pct: pct((tSpecific / wantSpecific) * 100), note: tuneUp ? `${tSpecific} quality session${tSpecific === 1 ? "" : "s"} done in the last 8 weeks (${wantSpecific}+ is plenty for a tune-up).` : `${tSpecific} race-pace session${tSpecific === 1 ? "" : "s"} done in the last 8 weeks (${wantSpecific}+ is ideal).` },
    {
      key: "ramp",
      label: "Safe build",
      pct: pct(tJump <= 0.12 ? 100 : tJump <= 0.25 ? 100 - ((tJump - 0.12) / 0.13) * 50 : 50 - Math.min(40, (tJump - 0.25) * 200)),
      note: tJump > 0.12 ? `Biggest jump: ${Math.round(tJump * 100)}% in a week (10–12% is safe).` : "No big jumps in mileage.",
    },
  ];
  const todayScore = Math.round(todayParts.reduce((a, p) => a + p.pct * WEIGHTS[p.key], 0) / (1 - WEIGHTS.taper));
  const shape = (2 / 3) * Math.min(1.5, avg / need.km) + (1 / 3) * Math.min(1, longest / need.long);
  const meters = km * 1000;
  const scaled = km >= 40 ? shape : km >= 20 ? shape * 0.43 : km >= 9 ? shape * 0.17 : shape * 0.07;
  // Training adds fitness by race day: what the plan was built to gain (or what a build that long usually gains).
  const b = plan.built;
  const isThisPlan = !!b && b.raceDate === race.date;
  // (The plan's own paces may stop at your goal; the prediction uses what training that long can add.)
  // Any other race ahead (a tune-up, or one without a plan built for it): the weeks of training
  // between now and then add fitness too, less the further it is (and none for one that's this week).
  const weeksTo = Math.max(0, diffDays(mondayOf(today), mondayOf(race.date!)) / 7);
  const level = b?.level ?? "intermediate";
  const gain = isThisPlan ? expectedGain(b!.weeks, b!.level) : weeksTo >= 2 ? expectedGain(weeksTo, level) : 0;
  const vNow = vdotAt(today) ?? v;
  // From today's fitness: the plan's gain, scaled by how well it prepares you.
  const base = Math.max(v, vNow);
  const likely = base + gain * Math.min(1, score / 100);
  const scale = (sh: number) => (km >= 40 ? sh : km >= 20 ? sh * 0.43 : km >= 9 ? sh * 0.17 : sh * 0.07);
  // A hilly course costs time; a flat one nothing.
  const hills = race.elevation ? elevationCost(race.elevation.gain, race.elevation.loss) : 0;
  let predicted = predictTime(meters, likely) * shapeFactor(meters, scaled) + hills;
  let range: [number, number] | null = gain > 0 ? [predictTime(meters, base + gain * 1.15) * shapeFactor(meters, scale(Math.max(1, shape))) + hills, predictTime(meters, base + gain * 0.4) * shapeFactor(meters, scaled) + hills] : null;
  // Today: your actual last 8 weeks against what the race needs.
  // Your best 8-week stretch of the last 16: a taper and recovery after a race don't make you unfit overnight.
  const wkKm: number[] = [];
  const wkLong: number[] = [];
  for (let i = 16; i >= 1; i--) {
    const mon = addDays(mondayOf(today), -7 * i);
    let wk = 0;
    let lg = 0;
    for (let d = 0; d < 7; d++) {
      const k = actual.get(addDays(mon, d)) ?? 0;
      wk += k;
      lg = Math.max(lg, k);
    }
    wkKm.push(wk);
    wkLong.push(lg);
  }
  let nowKm = 0;
  let nowLong = 0;
  for (let s = 0; s + 8 <= wkKm.length; s++) {
    const avg = wkKm.slice(s, s + 8).reduce((a, x) => a + x, 0) / 8;
    if (avg > nowKm) [nowKm, nowLong] = [avg, Math.max(...wkLong.slice(s, s + 8))];
  }
  const needNow = needsFor(km, vNow);
  const shapeNow = (2 / 3) * Math.min(1.5, nowKm / needNow.km) + (1 / 3) * Math.min(1, nowLong / needNow.long);
  let now = actual.size ? predictTime(meters, vNow) * shapeFactor(meters, scale(shapeNow)) + hills : null;
  // Garmin's prediction (when synced) is "now": it already allows for your endurance at this
  // distance. Race day keeps the same gain from training as above, on top of Garmin's time.
  const g = vdotAt.garmin?.(meters);
  if (g) {
    const nowOwn = predictTime(meters, vNow) * shapeFactor(meters, scale(shapeNow));
    const r = (t: number) => ((t - hills) / nowOwn) * g + hills;
    now = g + hills;
    predicted = r(predicted);
    if (range) range = [r(range[0]), r(range[1])];
  }
  const goal = race.target ? targetSeconds(race.target, meters) : null;
  return { score, parts, predicted, range, now, goal, distanceKm: km, today: { score: todayScore, parts: todayParts } };
}

function targetSeconds(text: string, meters: number): number | null {
  const all = [...text.matchAll(/(\d+):(\d{2})(?::(\d{2}))?/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  if (m[3]) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return meters >= 21000 ? +m[1] * 3600 + +m[2] * 60 : +m[1] * 60 + +m[2];
}

export const readinessTone = (s: number) => (s >= 85 ? "tone-accent" : s >= 65 ? "tone-warn" : "tone-danger");
