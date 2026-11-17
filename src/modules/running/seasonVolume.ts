import { addDays, diffDays } from "../../core/time";
import type { SeasonPhase } from "./season";
import { mondayOf } from "./plan";

/*
 * Weekly volume for a marathon season (plan generator v2 spec, step 2). Deterministic: every week's km follows
 * from the start km, the cap and the season's phases and races.
 *
 * Rules (spec v1.2 step 2, with the assumptions settled against the "Valencia plan v2" tab, documented here and
 * in seasonVolume.test.ts):
 *  - Start: the first week is the start km (your last full week). It isn't a build week.
 *  - Build weeks raise the usual level ("full week") by min(15 km, 15%, half the gap to the phase's level,
 *    at least 2 km). Phase levels, as shares of the cap (from v2): rebuild-and-sharpen 0.72, threshold base 0.85,
 *    first VO2 max block 0.88, later VO2 max blocks 0.92, A-secondary specific 0.92 (never above 0.93 × cap),
 *    A-primary specific 1.0.
 *  - Cutback: 82.5% of the usual level, after 3 build weeks (the count starts again at each phase, and the week
 *    after a race doesn't count), and the week after a focus week (in the same phase). Never on a focus week.
 *  - B or C race week: 72.5% of the usual level (the middle of 65–80%).
 *  - The week after a 10k-or-longer B race: 92% of the usual level, easing in after the race (from v2; added to
 *    the spec). It isn't a build week.
 *  - A-primary taper: 80%, 60%, 40% of the usual level (−20/−40/−60%). A-secondary taper: 75% of the week before,
 *    then 47% of that week plus the race.
 *  - Recovery after a marathon: 32.5%, 57.5%, 70% of the peak so far.
 *  - Ramp-back after recovery: the level starts again from the last recovery week and rises by up to 25% a week
 *    (towards the phase level) until it's back to 90% of the level before the break.
 *  - Floor: 50 km outside taper, race and recovery weeks.
 *  - A race with an approximate date counts in its nominal week; for focus weeks, every week within its window
 *    (± days; default 0, the nominal date only, as in v2) counts as a race week.
 */

export type WeekType = "start" | "build" | "cut" | "race" | "post" | "taper" | "recovery";
export interface VolumeWeek {
  monday: string;
  km: number;
  type: WeekType;
  focus: boolean;
  /** Index of the phase the week is in (season array). */
  phase: number;
}
export interface VolumeInput {
  start: string;
  weeks: number;
  season: SeasonPhase[];
  primary: string;
  startKm: number;
  cap: number;
  /** B and C races in the plan: date and distance; `window`: days either side for an approximate date. */
  races: { date: string; km: number; window?: number }[];
  /** Your own build-up rate (Fine-tune), a share a week: replaces the "half the gap" step (still within the caps). */
  growth?: number;
}

const LEVEL: Record<string, number> = { opening: 0.72, base: 0.85, vo2First: 0.88, vo2Later: 0.92, specificSecondary: 0.92, specificPrimary: 1 };

/**
 * Focus weeks (spec step 5, as settled): two per VO2 max block, the block's 3rd and 6th weeks; a week that's a
 * race week or straight after a race moves to the nearest allowed week (later first), and the two are never
 * next to each other.
 */
export function focusWeeks(season: SeasonPhase[], raceMondays: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const p of season.filter((x) => x.kind === "vo2")) {
    const weeks = Array.from({ length: p.weeks }, (_, k) => addDays(p.from, k * 7));
    const ok = (k: number) => k >= 0 && k < weeks.length && !raceMondays.has(weeks[k]) && !raceMondays.has(addDays(weeks[k], -7));
    const picked: number[] = [];
    for (const want of [2, 5]) {
      const tries = [want, want + 1, want - 1, want + 2, want - 2];
      const k = tries.find((t) => ok(t) && !picked.some((q) => Math.abs(q - t) <= 1));
      if (k !== undefined) picked.push(k);
    }
    for (const k of picked) out.add(weeks[k]);
  }
  return out;
}

export function seasonVolumes(input: VolumeInput): VolumeWeek[] {
  const { start, season, primary, cap } = input;
  const raceAt = new Map<string, number>();
  for (const r of input.races) raceAt.set(mondayOf(r.date), r.km);
  // Focus weeks keep away from every week an approximate race could fall in (and the week after it); the race's
  // volume and sessions go in its nominal week.
  const maybe = new Set(raceAt.keys());
  for (const r of input.races) for (let d = -(r.window ?? 0); d <= (r.window ?? 0); d++) maybe.add(mondayOf(addDays(r.date, d)));
  const focus = focusWeeks(season, maybe);
  const phaseIdx = (m: string) => season.findIndex((p) => p.from <= m && m <= p.to);
  const levelOf = (pi: number): number => {
    const p = season[pi];
    if (!p) return cap;
    const f =
      p.kind === "opening"
        ? LEVEL.opening
        : p.kind === "base"
          ? LEVEL.base
          : p.kind === "vo2"
            ? season.slice(0, pi).some((q) => q.kind === "vo2") ? LEVEL.vo2Later : LEVEL.vo2First
            : p.kind === "specific"
              ? p.race === primary ? LEVEL.specificPrimary : Math.min(LEVEL.specificSecondary, 0.93)
              : 1;
    return f * cap;
  };

  const out: VolumeWeek[] = [];
  let L = input.startKm;
  let builds = 0;
  let peak = input.startKm;
  let ramp: { pre: number } | null = null;
  let taperBase = 0;
  for (let i = 0; i < input.weeks; i++) {
    const monday = addDays(start, i * 7);
    const pi = phaseIdx(monday);
    const p = season[pi];
    const prev = out[i - 1];
    if (i > 0 && prev && prev.phase !== pi) builds = 0;
    let km: number;
    let type: WeekType;
    if (p?.kind === "taper") {
      const k = diffDays(p.from, monday) / 7;
      if (p.race === primary) {
        if (k === 0) taperBase = L;
        km = [0.8, 0.6, 0.4][Math.min(2, k)] * taperBase;
      } else {
        if (k === 0) taperBase = prev?.km ?? L;
        km = (k === 0 ? 0.75 : 0.47) * taperBase;
      }
      type = "taper";
      builds = 0;
    } else if (p?.kind === "recovery") {
      const k = diffDays(p.from, monday) / 7;
      km = [0.325, 0.575, 0.7][Math.min(2, k)] * peak;
      type = "recovery";
      builds = 0;
      if (!ramp) ramp = { pre: L };
      L = km;
    } else if (raceAt.has(monday)) {
      km = 0.725 * L;
      type = "race";
      builds = 0;
    } else if (prev && prev.type === "race" && (raceAt.get(prev.monday) ?? 0) >= 10) {
      km = 0.92 * L;
      type = "post";
    } else if (i === 0) {
      km = L;
      type = "start";
    } else {
      const lastFocus = prev && prev.focus && prev.phase === pi;
      const cut = !focus.has(monday) && (lastFocus || builds >= 3);
      if (cut) {
        km = 0.825 * L;
        type = "cut";
        builds = 0;
      } else {
        const target = levelOf(pi);
        if (L < target) {
          const lim = ramp ? 0.25 * L : Math.min(15, 0.15 * L);
          const step = input.growth != null ? input.growth * L : Math.max(2, (target - L) / 2);
          L = Math.min(target, L + Math.min(lim, step));
        }
        if (ramp && L >= 0.9 * ramp.pre) ramp = null;
        km = L;
        type = "build";
        builds++;
      }
    }
    if (type === "build" || type === "post" || type === "start") peak = Math.max(peak, km);
    out.push({ monday, km: Math.round(km), type, focus: focus.has(monday), phase: pi });
  }
  return out;
}
