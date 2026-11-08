import { addDays } from "../../core/time";
import { sessionToWorkout, type Zones } from "../watch/importWeek";
import type { Item, Step } from "../watch/steps";
import { zoneOf as hrZoneOf, type Zones as HrZones } from "./hrZones";
import type { Paces } from "./planBuilder";
import type { Run, RunDetail } from "./strava";

/**
 * Training focus, the way Garmin splits it: low aerobic (easy running: the base), high aerobic
 * (marathon pace to threshold: tempo and VO2-max-type work at the aerobic ceiling), and
 * anaerobic (5K pace and faster: short, very hard). For a planned workout from its paces,
 * for a run from its heart rate (else its pace) kilometre by kilometre.
 */
export type FocusKind = "low" | "high" | "anaerobic";
export const FOCUS_KINDS: { id: FocusKind; label: string; short: string }[] = [
  { id: "low", label: "Low aerobic", short: "Low aer." },
  { id: "high", label: "High aerobic", short: "High aer." },
  { id: "anaerobic", label: "Anaerobic", short: "Anaer." },
];
export type FocusMix = Record<FocusKind, number>;

/** Where the boundaries sit, as paces (s/km): slower than `low` is low aerobic, faster than `anaerobic` is anaerobic. */
export interface Cuts {
  low: number;
  anaerobic: number;
}
export const cutsFrom = (p: Paces | null): Cuts => (p ? { low: p.mp + 18, anaerobic: p.fivek + 4 } : { low: 290, anaerobic: 215 });

const paceOf = (target: string) => {
  const m = /(\d{1,2}):(\d{2})\s*(?:-\s*(\d{1,2}):(\d{2}))?/.exec(target);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2];
  const b = m[3] ? +m[3] * 60 + +m[4] : a;
  return (a + b) / 2;
};
function seconds(s: Step, fallbackPace: number): number {
  const d = s.duration.trim().toLowerCase();
  const p = paceOf(s.target) ?? fallbackPace;
  let m = /^(\d+(?:\.\d+)?)\s*km$/.exec(d);
  if (m) return +m[1] * p;
  m = /^(\d+)\s*m$/.exec(d);
  if (m) return (+m[1] / 1000) * p;
  m = /^(\d+):(\d{2})$/.exec(d);
  if (m) return +m[1] * 60 + +m[2];
  m = /^(\d+)\s*s$/.exec(d);
  if (m) return +m[1];
  return 600;
}
const flatten = (items: Item[]): Step[] => items.flatMap((it) => (it.kind === "repeat" ? Array.from({ length: it.times }, () => it.steps).flat() : [it]));
const share = (m: FocusMix): FocusMix => {
  const t = m.low + m.high + m.anaerobic || 1;
  return { low: m.low / t, high: m.high / t, anaerobic: m.anaerobic / t };
};

/** A planned workout's mix (shares of its time), from its steps and your paces. Null for rest days. */
export function plannedFocus(text: string, cuts: Cuts, zones: Zones = {}): FocusMix | null {
  const m = plannedSeconds(text, cuts, zones);
  return m ? share(m) : null;
}

/** A planned workout's seconds in each focus. Null for rest days or text it can't read. */
export function plannedSeconds(text: string, cuts: Cuts, zones: Zones = {}): FocusMix | null {
  if (!text || /^rest\b/i.test(text)) return null;
  const w = sessionToWorkout(text, zones);
  if (!w) return null;
  const m: FocusMix = { low: 0, high: 0, anaerobic: 0 };
  const easy = cuts.low + 35;
  for (const s of flatten(w.steps)) {
    const p = paceOf(s.target);
    const secs = seconds(s, p ?? easy);
    let k: FocusKind;
    if (p) k = p <= cuts.anaerobic ? "anaerobic" : p < cuts.low ? "high" : "low";
    else if (s.kind === "interval" && s.target === "open") k = /hill|sprint|stride/i.test(s.notes ?? "") || /hill/i.test(text) ? "anaerobic" : "high";
    else k = "low";
    m[k] += secs;
  }
  return m;
}

/**
 * A run's mix, kilometre by kilometre: anaerobic when it was run at about 5K pace or faster
 * (heart rate lags too much to show short, very hard efforts), otherwise its heart-rate zone
 * (1–3 low aerobic, 4–5 high aerobic), else its pace.
 */
export function runFocus(run: Pick<Run, "moving_time" | "distance" | "avg_hr">, detail: Pick<RunDetail, "splits"> | undefined, zones: Pick<HrZones, "floors"> | null, cuts: Cuts): FocusMix | null {
  const m: FocusMix = { low: 0, high: 0, anaerobic: 0 };
  const splits = detail?.splits?.filter((s) => s.moving_time > 0) ?? [];
  const kindOf = (secPerKm: number, hr: number | null | undefined): FocusKind => {
    if (secPerKm <= cuts.anaerobic) return "anaerobic";
    // Zones 1–3 are below your aerobic threshold (easy and steady running): low aerobic; 4 and 5 high.
    if (zones && hr) return hrZoneOf(hr, zones) <= 3 ? "low" : "high";
    return secPerKm < cuts.low ? "high" : "low";
  };
  if (splits.length) {
    for (const s of splits) m[kindOf(s.moving_time / Math.max(0.05, s.distance / 1000), s.hr)] += s.moving_time;
  } else if (run.moving_time > 0) {
    m[kindOf(run.moving_time / Math.max(0.05, run.distance / 1000), run.avg_hr)] += run.moving_time;
  } else return null;
  return share(m);
}

/** Weights for load (harder minutes count for more, like EPOC). */
const WEIGHT: FocusMix = { low: 1, high: 2.3, anaerobic: 3.6 };
/** Healthy share of load in each, over four weeks (roughly Garmin's optimal ranges). */
export const TARGET: Record<FocusKind, [number, number]> = { low: [0.45, 0.68], high: [0.22, 0.42], anaerobic: [0.06, 0.18] };

/** Load (weighted minutes) from seconds in each focus. */
export const loadOf = (secs: FocusMix): FocusMix => ({ low: (secs.low / 60) * WEIGHT.low, high: (secs.high / 60) * WEIGHT.high, anaerobic: (secs.anaerobic / 60) * WEIGHT.anaerobic });
export const addMix = (a: FocusMix, b: FocusMix): FocusMix => ({ low: a.low + b.low, high: a.high + b.high, anaerobic: a.anaerobic + b.anaerobic });
export const shareOf = share;
export const statusOf = (k: FocusKind, v: number): "in" | "below" | "above" => (v < TARGET[k][0] ? "below" : v > TARGET[k][1] ? "above" : "in");

/** A planned day as seconds by focus: its session's steps, else its km at easy pace. */
export function plannedDaySeconds(d: { text: string; km: number | null; flex?: [number, number]; optional?: boolean; kind: string }, cuts: Cuts, zones: Zones = {}): FocusMix | null {
  if (d.optional || d.kind === "rest" || /^rest\b/i.test(d.text)) return null;
  const easy = cuts.low + 35;
  if (d.kind === "race") {
    const km = d.km ?? 0;
    if (!km) return null;
    // Racing a 5K is anaerobic-heavy; 10K and up is mostly high aerobic.
    const t = km * (km <= 6 ? cuts.anaerobic : cuts.low - 20);
    return km <= 6 ? { low: 0, high: t * 0.4, anaerobic: t * 0.6 } : { low: 0, high: t, anaerobic: 0 };
  }
  const m = d.text ? plannedSeconds(d.text, cuts, zones) : null;
  const total = m ? m.low + m.high + m.anaerobic : 0;
  const km = d.km ?? (d.flex ? (d.flex[0] + d.flex[1]) / 2 : null);
  if (m && total > 0) {
    // Steps can miss the easy running around them: top up to the day's km.
    const plannedKm = km ?? 0;
    const extra = Math.max(0, plannedKm * easy - total - plannedKm * 30);
    return { ...m, low: m.low + extra };
  }
  return km ? { low: km * easy, high: 0, anaerobic: 0 } : null;
}

export interface LoadFocus {
  load: FocusMix;
  share: FocusMix;
  total: number;
  /** What's short of its range (the biggest gap first), or null when balanced. */
  short: FocusKind | null;
  /** What's well over its range, if anything. */
  over: FocusKind | null;
}

/** Four weeks of training load split by focus, and what's missing. */
export function loadFocus(runs: Pick<Run, "id" | "date" | "moving_time" | "distance" | "avg_hr">[], details: Map<string, Pick<RunDetail, "splits">>, zones: Pick<HrZones, "floors"> | null, cuts: Cuts, today: string): LoadFocus {
  const from = addDays(today, -27);
  const load: FocusMix = { low: 0, high: 0, anaerobic: 0 };
  for (const r of runs) {
    if (r.date < from || r.date > today) continue;
    const f = runFocus(r, details.get(r.id), zones, cuts);
    if (!f) continue;
    const mins = r.moving_time / 60;
    for (const k of ["low", "high", "anaerobic"] as FocusKind[]) load[k] += f[k] * mins * WEIGHT[k];
  }
  const total = load.low + load.high + load.anaerobic;
  const sh = share(load);
  let short: FocusKind | null = null;
  let gap = 0;
  let over: FocusKind | null = null;
  if (total > 0)
    for (const k of ["anaerobic", "high", "low"] as FocusKind[]) {
      const g = TARGET[k][0] - sh[k];
      if (g > gap + 0.01) {
        gap = g;
        short = k;
      }
      if (sh[k] > TARGET[k][1] + 0.05 && !over) over = k;
    }
  return { load, share: sh, total, short, over };
}

/** What to run to fill a gap. */
export const FILL: Record<FocusKind, { focus: "long" | "easy" | "threshold" | "overunder" | "tempo" | "vo2" | "fartlek" | "hills"; why: string }[]> = {
  low: [
    { focus: "long", why: "Your low aerobic base is short: a long, easy run builds it." },
    { focus: "easy", why: "More easy running fills your low aerobic base." },
  ],
  high: [
    { focus: "threshold", why: "Short of high aerobic work: threshold reps raise the pace you can hold." },
    { focus: "overunder", why: "Short of high aerobic work: over-unders hit threshold and just above." },
    { focus: "tempo", why: "Short of high aerobic work: a steady tempo fills it." },
  ],
  anaerobic: [
    { focus: "vo2", why: "Short of anaerobic work: fast reps at 3K–5K pace." },
    { focus: "hills", why: "Short of anaerobic work: hard hill reps add power." },
    { focus: "fartlek", why: "Short of anaerobic work: a fartlek with fast minutes." },
  ],
};
