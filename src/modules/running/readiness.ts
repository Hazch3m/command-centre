import { addDays } from "../../core/time";
import { shapeFactor } from "./fitness";
import { forecastWeek, raceKm, type ForecastDay } from "./forecast";
import { mondayOf, type Plan, type PlanRace } from "./plan";
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
  goal: number | null;
  distanceKm: number;
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

export function raceReadiness(
  plan: Plan,
  race: Pick<PlanRace, "date" | "name" | "km" | "target">,
  today: string,
  vdotAt: (date: string) => number | null,
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
  const isSpecific = (d: ForecastDay) => re.test(d.text) || (km >= 40 && d.kind === "long" && /\bat\s+\d:\d\d/.test(d.text));
  const specificDays = weeks.slice(-10, -1).flatMap((w) => w.days.filter((d) => (d.kind === "key" || d.kind === "long") && isSpecific(d)));
  const wantSpecific = km >= 20 ? 5 : 6;
  const specific = pct((specificDays.length / wantSpecific) * 100);
  const peak = Math.max(...build.slice(-6).map((w) => w.km), 1);
  const raceWeek = weeks[weeks.length - 1].km / peak;
  const prevWeek = weeks[weeks.length - 2].km / peak;
  const [rwOk, pwOk] = km >= 40 ? [0.6, 0.85] : km >= 20 ? [0.75, 0.95] : [0.85, 1.05];
  const taper = pct(100 - Math.max(0, raceWeek - rwOk) * 200 - Math.max(0, prevWeek - pwOk) * 150);
  let jump = 0;
  for (let i = 1; i < build.length; i++) {
    const a = build[i - 1].km;
    const b = build[i].km;
    // Coming back from an easier week isn't a jump.
    const ref = Math.max(a, i >= 2 ? build[i - 2].km : 0);
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
      note: `${specificDays.length} session${specificDays.length === 1 ? "" : "s"} at or around race pace in the last 9 weeks (${wantSpecific}+ is ideal).`,
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
  const shape = (2 / 3) * Math.min(1.5, avg / need.km) + (1 / 3) * Math.min(1, longest / need.long);
  const meters = km * 1000;
  const scaled = km >= 40 ? shape : km >= 20 ? shape * 0.43 : km >= 9 ? shape * 0.17 : shape * 0.07;
  const predicted = predictTime(meters, v) * shapeFactor(meters, scaled);
  const goal = race.target ? targetSeconds(race.target, meters) : null;
  return { score, parts, predicted, goal, distanceKm: km };
}

function targetSeconds(text: string, meters: number): number | null {
  const all = [...text.matchAll(/(\d+):(\d{2})(?::(\d{2}))?/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  if (m[3]) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  return meters >= 21000 ? +m[1] * 3600 + +m[2] * 60 : +m[1] * 60 + +m[2];
}

export const readinessTone = (s: number) => (s >= 85 ? "tone-accent" : s >= 65 ? "tone-warn" : "tone-danger");
