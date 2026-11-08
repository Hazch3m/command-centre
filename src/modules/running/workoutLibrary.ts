import type { Paces } from "./planBuilder";

/**
 * Workouts you make yourself (the app's "Create a workout"): pick what to work
 * on, take a suggestion at your paces, adjust it, send it to the watch or put it
 * in your plan. Written in the plan's own words ("12 km with 3 km warm-up,
 * VO2 max: 6 × 800 m at 3:28–3:32, 90 s jog, 2 km cool-down"), so the watch,
 * the plan and Pace on point all understand it.
 */
export type Focus = "vo2" | "threshold" | "tempo" | "overunder" | "racepace" | "fartlek" | "hills" | "progression" | "long" | "easy" | "recovery";

export const FOCUSES: { id: Focus; label: string; what: string; zone: "vo2" | "threshold" | "race" | "long" | "easy" }[] = [
  { id: "vo2", label: "VO2 max", what: "Speed and top-end aerobic power: short, hard reps at 3k–5k pace", zone: "vo2" },
  { id: "threshold", label: "Threshold", what: "Hold a hard pace for longer: reps at the pace you could race for an hour", zone: "threshold" },
  { id: "tempo", label: "Tempo", what: "One continuous block at threshold: steady and strong", zone: "threshold" },
  { id: "overunder", label: "Over-unders", what: "Threshold with surges: just under, then just over, so you learn to clear lactate on the move", zone: "threshold" },
  { id: "racepace", label: "Race pace", what: "Rehearse your goal race's pace until it feels routine", zone: "race" },
  { id: "fartlek", label: "Fartlek", what: "Minutes on, minutes off: varied, playful, by feel", zone: "vo2" },
  { id: "hills", label: "Hills", what: "Strength and form: hard uphill reps, jog back down", zone: "vo2" },
  { id: "progression", label: "Progression", what: "Start easy, finish fast: practise running strong when tired", zone: "threshold" },
  { id: "long", label: "Long run", what: "Endurance: time on your feet, optionally with a fast finish", zone: "long" },
  { id: "easy", label: "Easy + strides", what: "Aerobic base with a few short, relaxed accelerations", zone: "easy" },
  { id: "recovery", label: "Recovery", what: "Very easy and short: blood flow, nothing more", zone: "easy" },
];

/** A workout's adjustable parts; the text is made from them. */
export interface Spec {
  focus: Focus;
  /** Reps (rep sessions), or 1 for a continuous block. */
  reps: number;
  /** One rep: metres, or seconds when `timed`. */
  size: number;
  timed: boolean;
  /** Target pace, s/km (0: by feel). */
  pace: number;
  /** Recovery between reps, seconds (0: jog back down a hill). */
  rec: number;
  warm: number;
  cool: number;
  /** Total distance for continuous runs (long, easy, progression, recovery). */
  km: number;
  /** Fast finish for long runs and progression runs, km. */
  fast: number;
  /** Recovery as a float at this pace (s/km) instead of a jog: fartleks. */
  float?: number;
  /** Which race pace ("MP", "HMP", or none for 10k/5k). */
  raceTag?: "MP" | "HMP";
  name: string;
  /** Rep sessions with more than one set ("4 × 1 min, then 4 × 2 min"): every set, the first included. */
  sets?: RepSet[];
  /** Progression and long runs in steps: each faster block after the easy start, in order. */
  blocks?: Block[];
  /** Over-unders: `reps` blocks of these, `rec` between blocks. */
  ou?: OverUnder;
}
export interface RepSet {
  reps: number;
  size: number;
  timed: boolean;
  pace: number;
  rec: number;
  /** Recovery as a float at this pace (s/km) instead of a jog: fartleks. */
  float?: number;
}
/** Over-unders: blocks of `pairs` × (under, over) around threshold. */
export interface OverUnder {
  pairs: number;
  under: number;
  over: number;
  underPace: number;
  overPace: number;
}
export interface Block {
  km: number;
  pace: number;
}

/** The sets of a rep session (one, unless you've added more). */
export const setsOf = (sp: Spec): RepSet[] => sp.sets ?? [{ reps: sp.reps, size: sp.size, timed: sp.timed, pace: sp.pace, rec: sp.rec, float: sp.float }];
/** The faster blocks of a progression or long run (none for a plain long run). */
export const blocksOf = (sp: Spec): Block[] => sp.blocks ?? (sp.fast > 0 ? [{ km: sp.fast, pace: sp.pace }] : []);
/** A spec with its sets changed; the first set stays mirrored in the plain fields. */
export function withSets(sp: Spec, sets: RepSet[]): Spec {
  const [a] = sets;
  return { ...sp, sets: sets.length > 1 ? sets : undefined, reps: a.reps, size: a.size, timed: a.timed, pace: a.pace, rec: a.rec, float: a.float };
}
/** A spec with its blocks changed (the total distance grows to fit them with a 2 km easy start). */
export function withBlocks(sp: Spec, blocks: Block[]): Spec {
  const fast = blocks.reduce((t, b) => t + b.km, 0);
  const km = Math.max(sp.km, fast + 2);
  return { ...sp, km, blocks: blocks.length > 1 ? blocks : undefined, fast: blocks.length ? fast : 0, pace: blocks.length ? blocks[blocks.length - 1].pace : sp.pace };
}

const fmtP = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const around = (s: number, d = 2) => `${fmtP(s - d)}–${fmtP(s + d)}`;
const fmtLen = (sp: Spec) => (sp.timed ? (sp.size >= 60 && sp.size % 60 === 0 ? `${sp.size / 60} min` : `${sp.size} s`) : sp.size >= 1000 ? `${+(sp.size / 1000).toFixed(1)} km` : `${sp.size} m`);
const fmtRec = (sec: number) => (sec === 0 ? "jog back down" : sec >= 60 && sec % 60 === 0 ? `${sec / 60} min jog` : `${sec} s jog`);
const fmtSecs = (sec: number) => (sec >= 60 && sec % 60 === 0 ? `${sec / 60} min` : `${sec} s`);
/** "1 min jog", or a float: "1 min float at 4:28–4:34". */
const recText = (sec: number, float?: number) => (float ? `${fmtSecs(sec)} float at ${around(float, 3)}` : fmtRec(sec));
const LABEL: Partial<Record<Focus, string>> = { vo2: "VO2 max", threshold: "Threshold", tempo: "Threshold tempo", racepace: "Race pace", hills: "Hill strength" };

/** Distance a spec covers (warm-up, work, jogs, cool-down), km. */
export function specKm(sp: Spec): number {
  if (["long", "easy", "recovery", "progression"].includes(sp.focus)) return sp.km;
  if (sp.focus === "overunder" && sp.ou) {
    const o = sp.ou;
    const work = sp.reps * o.pairs * (o.under / o.underPace + o.over / o.overPace);
    return Math.round(sp.warm + sp.cool + work + ((sp.reps - 1) * sp.rec) / 360);
  }
  let work = 0;
  let jogs = 0;
  for (const x of setsOf(sp)) {
    work += x.timed ? (x.reps * x.size) / (x.pace || 240) : (x.reps * x.size) / 1000;
    jogs += (Math.max(0, x.reps - 1) * (x.rec || 90)) / (x.float || 360);
  }
  // A couple of easy minutes between sets.
  jogs += (setsOf(sp).length - 1) * 0.4;
  return Math.round(sp.warm + sp.cool + work + jogs);
}

const lenOf = (x: RepSet) => fmtLen({ timed: x.timed, size: x.size } as Spec);
/** One set in words: "4 × 1 min at 3:38–3:42, 1 min jog". */
function setText(sp: Spec, x: RepSet): string {
  const tag = sp.focus === "racepace" && sp.raceTag ? `${sp.raceTag} ` : "";
  if (sp.focus === "hills") return `${x.reps} × ${lenOf(x)} hill reps, jog back down`;
  const at = x.pace > 0 ? ` at ${tag}${around(x.pace)}` : "";
  return `${x.reps} × ${lenOf(x)}${sp.focus === "fartlek" ? " fartlek" : x.timed && sp.focus === "threshold" ? " T" : ""}${at}, ${recText(x.rec, x.float)}`;
}

/** The workout in the plan's words. */
export function specText(sp: Spec): string {
  // Several sets: each in turn, "then" between them.
  if (sp.sets && sp.sets.length > 1 && !["long", "easy", "recovery", "progression", "tempo"].includes(sp.focus)) {
    const label = sp.focus === "fartlek" ? "Fartlek" : LABEL[sp.focus] ?? "Intervals";
    return `${specKm(sp)} km with ${sp.warm} km warm-up, ${label}: ${sp.sets.map((x) => setText(sp, x)).join("; then ")}; ${sp.cool} km cool-down`;
  }
  // Progression or long run in steps: an easy start, then each block faster.
  if (sp.blocks && sp.blocks.length > 1 && (sp.focus === "progression" || sp.focus === "long")) {
    const fast = sp.blocks.reduce((t, b) => t + b.km, 0);
    const easy = Math.max(0, +(sp.km - fast).toFixed(1));
    return `${sp.km} km ${sp.focus === "long" ? "long run" : "progression run"}: ${easy} km easy, ${sp.blocks.map((b) => `${b.km} km at ${around(b.pace, 3)}`).join(", ")}`;
  }
  switch (sp.focus) {
    case "long":
      return sp.fast > 0 ? `${sp.km} km long run, last ${sp.fast} at ${around(sp.pace, 3)}` : `${sp.km} km long run`;
    case "progression":
      return `${sp.km} km progression run, last ${sp.fast} at ${around(sp.pace, 3)}`;
    case "easy":
      return `${sp.km} km easy + ${sp.reps} × 20 s strides`;
    case "recovery":
      return `${sp.km} km recovery`;
    case "tempo":
      return `${specKm(sp)} km with ${sp.warm} km warm-up, ${LABEL.tempo}: ${Math.round(sp.size / 60)} min T at ${around(sp.pace)}, ${sp.cool} km cool-down`;
    case "racepace": {
      const tag = sp.raceTag ? `${sp.raceTag} ` : "";
      const work = sp.reps === 1 ? `${+(sp.size / 1000).toFixed(1)} km at ${tag}${around(sp.pace)}` : `${sp.reps} × ${fmtLen(sp)} at ${tag}${around(sp.pace)}, ${fmtRec(sp.rec)}`;
      return `${specKm(sp)} km with ${sp.warm} km warm-up, ${LABEL.racepace}: ${work}, ${sp.cool} km cool-down`;
    }
    case "fartlek":
      return `${specKm(sp)} km with ${sp.warm} km warm-up, ${sp.reps} × ${fmtLen(sp)} fartlek at ${around(sp.pace)}, ${recText(sp.rec, sp.float)}, ${sp.cool} km cool-down`;
    case "overunder": {
      const o = sp.ou!;
      return `${specKm(sp)} km with ${sp.warm} km warm-up, Threshold over-unders: ${sp.reps} × (${o.pairs} × ${fmtSecs(o.under)} at ${around(o.underPace)} + ${fmtSecs(o.over)} at ${around(o.overPace)}), ${fmtRec(sp.rec)}, ${sp.cool} km cool-down`;
    }
    case "hills":
      return `${specKm(sp)} km with ${sp.warm} km warm-up, ${LABEL.hills}: ${sp.reps} × ${fmtLen(sp)} hill reps, jog back down, ${sp.cool} km cool-down`;
    default:
      return `${specKm(sp)} km with ${sp.warm} km warm-up, ${LABEL[sp.focus]}: ${sp.reps} × ${fmtLen(sp)} ${sp.timed && sp.focus === "threshold" ? "T " : ""}at ${around(sp.pace)}, ${fmtRec(sp.rec)}, ${sp.cool} km cool-down`;
  }
}

type Size = "short" | "classic" | "big";
const SIZES: { id: Size; name: string }[] = [
  { id: "short", name: "Short" },
  { id: "classic", name: "Classic" },
  { id: "big", name: "Big" },
];

/**
 * Three suggestions for a focus at your paces: a short one, the classic, and a big one
 * (for VO2 max, for example: 8 × 400 m, 6 × 800 m, 5 × 1.2 km).
 */
export function suggestions(focus: Focus, p: Paces, raceDist: "marathon" | "half" | "10k" | "5k" = "marathon"): Spec[] {
  const base = { focus, reps: 1, size: 0, timed: false, pace: 0, rec: 90, warm: 3, cool: 2, km: 0, fast: 0 };
  const E = Math.round(p.easy[1]);
  const each = (f: (s: Size) => Partial<Spec> & { name: string }) => SIZES.map((s) => ({ ...base, ...f(s.id) }) as Spec);
  switch (focus) {
    case "vo2":
      return each((s) =>
        s === "short"
          ? { name: "8 × 400 m", reps: 8, size: 400, pace: Math.round(p.interval - 6), rec: 60 }
          : s === "classic"
            ? { name: "6 × 800 m", reps: 6, size: 800, pace: Math.round(p.interval - 2), rec: 90 }
            : { name: "5 × 1.2 km", reps: 5, size: 1200, pace: Math.round(p.interval + 2), rec: 120 },
      );
    case "threshold":
      return each((s) =>
        s === "short"
          ? { name: "5 × 1 km", reps: 5, size: 1000, pace: Math.round(p.threshold - 2), rec: 60 }
          : s === "classic"
            ? { name: "4 × 2 km", reps: 4, size: 2000, pace: Math.round(p.threshold), rec: 90 }
            : { name: "3 × 10 min", reps: 3, size: 600, timed: true, pace: Math.round(p.threshold), rec: 120 },
      );
    case "tempo":
      return each((s) => ({ name: s === "short" ? "20 min tempo" : s === "classic" ? "30 min tempo" : "40 min tempo", size: (s === "short" ? 20 : s === "classic" ? 30 : 40) * 60, pace: Math.round(p.threshold + (s === "big" ? 4 : 0)) }));
    case "racepace": {
      const race = raceDist === "marathon" ? p.mp : raceDist === "half" ? p.hmp : raceDist === "10k" ? p.tenk : p.fivek;
      const tag = raceDist === "marathon" ? ("MP" as const) : raceDist === "half" ? ("HMP" as const) : undefined;
      if (raceDist === "marathon")
        return each((s) =>
          s === "short"
            ? { name: "3 × 3 km at MP", reps: 3, size: 3000, pace: Math.round(race), rec: 120, raceTag: tag }
            : s === "classic"
              ? { name: "12 km at MP", reps: 1, size: 12000, pace: Math.round(race), raceTag: tag }
              : { name: "2 × 8 km at MP", reps: 2, size: 8000, pace: Math.round(race), rec: 180, raceTag: tag },
        );
      return each((s) =>
        s === "short"
          ? { name: `5 × 1 km at race pace`, reps: 5, size: 1000, pace: Math.round(race), rec: 90, raceTag: tag }
          : s === "classic"
            ? { name: `4 × 2 km at race pace`, reps: 4, size: 2000, pace: Math.round(race), rec: 120, raceTag: tag }
            : { name: `3 × 3 km at race pace`, reps: 3, size: 3000, pace: Math.round(race), rec: 120, raceTag: tag },
      );
    }
    case "fartlek":
      // Floats, not jogs: the recoveries stay brisk (around marathon pace), so the whole run keeps moving.
      return each((s) =>
        s === "short"
          ? { name: "10 × 1 min, 1 min float", reps: 10, size: 60, timed: true, pace: Math.round(p.fivek), rec: 60, float: Math.round(p.mp + 15) }
          : s === "classic"
            ? { name: "8 × 2 min, 1 min float", reps: 8, size: 120, timed: true, pace: Math.round(p.tenk), rec: 60, float: Math.round(p.mp + 10) }
            : { name: "6 × 4 min, 2 min float", reps: 6, size: 240, timed: true, pace: Math.round(p.threshold + 3), rec: 120, float: Math.round(p.mp + 5) },
      );
    case "overunder": {
      const ou = (pairs: number, under: number, over: number): OverUnder => ({ pairs, under, over, underPace: Math.round(p.threshold + 6), overPace: Math.round(p.threshold - 8) });
      return each((s) =>
        s === "short"
          ? { name: "3 × (3 × 90 s / 30 s)", reps: 3, rec: 120, ou: ou(3, 90, 30) }
          : s === "classic"
            ? { name: "3 × (4 × 2 min / 1 min)", reps: 3, rec: 120, ou: ou(4, 120, 60) }
            : { name: "2 × (5 × 3 min / 1 min)", reps: 2, rec: 180, ou: ou(5, 180, 60) },
      );
    }
    case "hills":
      return each((s) =>
        s === "short"
          ? { name: "8 × 45 s hills", reps: 8, size: 45, timed: true, rec: 0 }
          : s === "classic"
            ? { name: "10 × 60 s hills", reps: 10, size: 60, timed: true, rec: 0 }
            : { name: "6 × 2 min hills", reps: 6, size: 120, timed: true, rec: 0 },
      );
    case "progression":
      return each((s) => ({ name: s === "short" ? "10 km, last 3 fast" : s === "classic" ? "14 km, last 4 fast" : "18 km, last 6 fast", km: s === "short" ? 10 : s === "classic" ? 14 : 18, fast: s === "short" ? 3 : s === "classic" ? 4 : 6, pace: Math.round(s === "big" ? p.mp : p.mp + 8) }));
    case "long":
      return each((s) =>
        s === "short" ? { name: "20 km steady", km: 20, pace: E } : s === "classic" ? { name: "26 km, fast finish", km: 26, fast: 4, pace: Math.round(p.mp + 8) } : { name: "32 km, last 10 at MP", km: 32, fast: 10, pace: Math.round(p.mp) },
      );
    case "easy":
      return each((s) => ({ name: s === "short" ? "8 km + strides" : s === "classic" ? "10 km + strides" : "14 km + strides", km: s === "short" ? 8 : s === "classic" ? 10 : 14, reps: 6 }));
    case "recovery":
      return each((s) => ({ name: s === "short" ? "5 km recovery" : s === "classic" ? "7 km recovery" : "9 km recovery", km: s === "short" ? 5 : s === "classic" ? 7 : 9 }));
  }
}

/** What to work on today, from your recent running, readiness and the plan. */
export function suggestFocus(o: {
  readiness: number | null;
  hardDaysAgo: number | null;
  planToday: string | null;
  longDaysAgo: number | null;
  /** What your last four weeks are short of (Garmin-style load focus), as a workout to fill it. */
  loadShort?: { focus: Focus; why: string } | null;
}): { focus: Focus; why: string } {
  if (o.readiness != null && o.readiness < 40) return { focus: "recovery", why: `Readiness is ${o.readiness}: keep today very easy.` };
  if (o.hardDaysAgo != null && o.hardDaysAgo <= 1) return { focus: "easy", why: "You ran a hard session in the last day or two: easy running lets it pay off." };
  if (o.planToday && /VO2|× .*m at|fartlek/i.test(o.planToday)) return { focus: "vo2", why: "Your plan has speed work today." };
  if (o.planToday && /threshold|tempo|\bT\b/i.test(o.planToday)) return { focus: "threshold", why: "Your plan has a threshold session today." };
  if (o.planToday && /long run/i.test(o.planToday)) return { focus: "long", why: "Your plan has a long run today." };
  if (o.loadShort) return o.loadShort;
  if (o.longDaysAgo == null || o.longDaysAgo >= 7) return { focus: "long", why: "No long run for a week or more: time on your feet builds endurance." };
  if (o.hardDaysAgo == null || o.hardDaysAgo >= 4) return { focus: "threshold", why: `No hard session for ${o.hardDaysAgo ?? "a few"} days: a threshold session is the best value for fitness.` };
  return { focus: "fartlek", why: "Fresh and in a good rhythm: a fartlek keeps speed fun." };
}
