import { addDays, diffDays } from "../../core/time";
import { mondayOf } from "./plan";

/*
 * Season segmentation (plan generator v2 spec, step 1): the phases of a marathon season, worked out
 * backwards from your goal race (the A-primary race), with an A-secondary marathon fitted in before it.
 *
 *   A-primary marathon:  taper 3 weeks (race week included) · specific 10–13 weeks · VO2 max 6–8 · threshold base the rest
 *   A-secondary marathon: taper 2 weeks · specific 6–8 · VO2 max 6–8 · base the rest · then a 3-week recovery
 *   Opening "rebuild and sharpen": if the plan starts within 8 weeks after a marathon, or a B race is within
 *   6 weeks of the start — from the start to that race's week (3–6 weeks), else 4 weeks.
 *
 * Assumptions carried from the spec review (documented here and in season.test.ts):
 *  1. Ranges: within the allowed range, a block ends with a B race week where one falls at a possible
 *     boundary (the next block starts the day after); otherwise the middle of the range (rounded up).
 *  2. The A-primary specific block may be 10–13 weeks, and there's no threshold base after a recovery
 *     phase (recovery → VO2 max → specific) unless the time left is more than the longest VO2 max and
 *     specific blocks together.
 *  3. If time is short, shorten the base, then the VO2 max block, then the specific block (A-primary
 *     never below 8 weeks, A-secondary never below 6). A base of 1–2 weeks merges into the VO2 max block.
 */

export type SeasonKind = "opening" | "base" | "vo2" | "specific" | "taper" | "recovery";
export interface SeasonPhase {
  kind: SeasonKind;
  /** The race this phase builds to (or recovers from). */
  race?: string;
  /** Mondays of the first and last week. */
  from: string;
  to: string;
  weeks: number;
}
export interface SeasonRace {
  name: string;
  date: string;
  /** Days either side for a race with an approximate date (0 = fixed). */
  uncertainty?: number;
}
export interface SeasonInput {
  /** Monday of the plan's first week. */
  start: string;
  primary: SeasonRace;
  /** A marathons before the goal race (raced seriously), in date order. */
  secondaries?: SeasonRace[];
  /** B and C races, for the block boundaries. */
  others?: SeasonRace[];
  /** Date of your last marathon before the plan starts, if any. */
  lastMarathon?: string | null;
}

const RANGES = {
  primary: { taper: 3, spec: [10, 13] as const, specMin: 8 },
  secondary: { taper: 2, spec: [6, 8] as const, specMin: 6 },
  vo2: [6, 8] as const,
  vo2Min: 4,
  baseMin: 3,
  recovery: 3,
};

/** Week index (from the plan's first Monday) of a date. */
const weekOf = (start: string, date: string) => Math.floor(diffDays(start, mondayOf(date)) / 7);
const mid = (r: readonly [number, number]) => Math.ceil((r[0] + r[1]) / 2);

/**
 * A block ending the week before `end` (exclusive index), length within [lo, hi]: the length that makes
 * the block before it end with a B race week (closest to the middle), else the middle. Never longer than
 * `room` weeks.
 */
function blockLength(end: number, lo: number, hi: number, room: number, raceWeeks: Set<number>): number {
  const m = Math.min(room, mid([lo, hi]));
  const fits: number[] = [];
  for (let L = lo; L <= Math.min(hi, room); L++) if (raceWeeks.has(end - L - 1)) fits.push(L);
  if (fits.length) return fits.sort((a, b) => Math.abs(a - m) - Math.abs(b - m) || b - a)[0];
  return Math.max(Math.min(lo, room), m);
}

/**
 * One marathon's build in the weeks [from, raceWeek]: taper, specific, VO2 max and base (if allowed),
 * filling the time exactly. Returns phases in date order (as week indices).
 */
function chain(
  from: number,
  raceWeek: number,
  race: string,
  tier: "primary" | "secondary",
  baseAllowed: boolean,
  raceWeeks: Set<number>,
): { kind: SeasonKind; race: string; a: number; b: number }[] {
  const R = RANGES[tier];
  const out: { kind: SeasonKind; race: string; a: number; b: number }[] = [];
  const taperFrom = Math.max(from, raceWeek - R.taper + 1);
  out.unshift({ kind: "taper", race, a: taperFrom, b: raceWeek });
  let room = taperFrom - from;
  if (room <= 0) return out;
  // Specific block: within its range (never shortened before the base and VO2 max block are gone).
  let spec = blockLength(taperFrom, R.spec[0], R.spec[1], room, raceWeeks);
  let rest = room - spec;
  let vo2 = rest > 0 ? blockLength(taperFrom - spec, RANGES.vo2[0], RANGES.vo2[1], rest, raceWeeks) : 0;
  let base = rest - vo2;
  if (!baseAllowed && base > 0) {
    // No base after a recovery phase: the specific block takes up to its maximum, then the VO2 max block.
    const addSpec = Math.min(base, R.spec[1] - spec);
    spec += addSpec;
    base -= addSpec;
    const addVo2 = Math.min(base, RANGES.vo2[1] - vo2);
    vo2 += addVo2;
    base -= addVo2;
  }
  if (base > 0 && base < RANGES.baseMin) {
    vo2 += base;
    base = 0;
  }
  if (vo2 > 0 && vo2 < RANGES.vo2Min && base === 0) {
    // Too short to be a block of its own: it goes to the specific block (up to its maximum).
    const add = Math.min(vo2, Math.max(0, R.spec[1] + 1 - spec));
    spec += add;
    vo2 -= add;
  }
  let end = taperFrom;
  out.unshift({ kind: "specific", race, a: end - spec, b: end - 1 });
  end -= spec;
  if (vo2 > 0) {
    out.unshift({ kind: "vo2", race, a: end - vo2, b: end - 1 });
    end -= vo2;
  }
  if (base > 0) out.unshift({ kind: "base", race, a: end - base, b: end - 1 });
  return out;
}

export function segmentSeason(input: SeasonInput): SeasonPhase[] {
  const { start, primary } = input;
  const raceWeeks = new Set((input.others ?? []).filter((r) => !r.uncertainty).map((r) => weekOf(start, r.date)));
  const P = weekOf(start, primary.date);
  const secs = (input.secondaries ?? []).filter((r) => r.date < primary.date && weekOf(start, r.date) >= 0).sort((a, b) => a.date.localeCompare(b.date));
  const parts: { kind: SeasonKind; race?: string; a: number; b: number }[] = [];

  // Opening "rebuild and sharpen": straight after a marathon, or with a B race in the first 6 weeks.
  const sinceMarathon = input.lastMarathon ? diffDays(input.lastMarathon, start) : Infinity;
  const firstB = [...raceWeeks].filter((w) => w >= 0 && w <= 5).sort((a, b) => a - b)[0];
  let from = 0;
  if (sinceMarathon <= 56 || firstB !== undefined) {
    const len = firstB !== undefined ? Math.min(6, Math.max(3, firstB + 1)) : 4;
    // Only if it leaves room for the first marathon's build.
    const firstRace = secs.length ? weekOf(start, secs[0].date) : P;
    if (firstRace - len >= RANGES.secondary.taper + RANGES.secondary.spec[0]) {
      parts.push({ kind: "opening", a: 0, b: len - 1 });
      from = len;
    }
  }

  let baseAllowed = true;
  for (const s of secs) {
    const sw = weekOf(start, s.date);
    // The secondary race must leave time for the recovery and the primary race's taper and specific block.
    if (P - sw - RANGES.recovery < RANGES.primary.taper + RANGES.primary.specMin) continue;
    parts.push(...chain(from, sw, s.name, "secondary", baseAllowed, raceWeeks));
    parts.push({ kind: "recovery", race: s.name, a: sw + 1, b: sw + RANGES.recovery });
    from = sw + RANGES.recovery + 1;
    baseAllowed = false;
  }
  parts.push(...chain(from, P, primary.name, "primary", baseAllowed, raceWeeks));

  return parts
    .filter((p) => p.b >= p.a && p.b >= 0)
    .map((p) => {
      const a = Math.max(0, p.a);
      return { kind: p.kind, race: p.race, from: addDays(start, a * 7), to: addDays(start, p.b * 7), weeks: p.b - a + 1 };
    });
}

/** The phase a week (by its Monday) falls in. */
export function phaseAt(phases: SeasonPhase[], monday: string): SeasonPhase | undefined {
  return phases.find((p) => p.from <= monday && monday <= p.to);
}

/** What each phase is called in the plan. */
export function seasonLabel(p: SeasonPhase, primary: string): string {
  const short = (n?: string) => (n ?? "").replace(/\s+(marathon|half marathon|half|10 ?k|5 ?k)\s*$/i, "").trim() || n || "";
  switch (p.kind) {
    case "opening":
      return "Rebuild and sharpen";
    case "base":
      return "Threshold base";
    case "vo2":
      return "VO2 max block";
    case "specific":
      return `${short(p.race)}-specific`;
    case "taper":
      return p.race === primary ? "Taper" : `${short(p.race)} taper`;
    case "recovery":
      return "Recovery";
  }
}
