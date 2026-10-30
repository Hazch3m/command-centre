import { parseTime } from "./stats";
import type { ForecastDay } from "./forecast";
import type { Run, RunDetail } from "./strava";

/**
 * "Pace on point": how close each run was to the pace the plan asked for.
 *
 * Easy and long runs are judged on the whole run, where slower than the range
 * still counts as on point (easy is a ceiling, not a target). Sessions with a
 * pace (reps, threshold, marathon-pace blocks) are judged on the work only:
 * the watch laps that look like reps, or else the fastest kilometres that add
 * up to the work distance.
 */

export type PaceVerdict = "on-point" | "slightly-fast" | "too-fast" | "slightly-slow" | "too-slow";

export interface PaceCheck {
  runId: string;
  date: string;
  /** What was measured: "whole run", "4 work laps", "fastest 6 km". */
  measured: string;
  target: [number, number]; // s/km, fast..slow
  actual: number; // s/km
  /** Seconds per km outside the range: negative = faster, positive = slower, 0 = inside. */
  off: number;
  verdict: PaceVerdict;
  /** 0–100. */
  score: number;
  /** Share of the work laps or km inside the range (when the work could be split up). */
  inRange: number | null;
  plannedKm: number | null;
  ranKm: number;
  /** Sessions: pace of the quickest and slowest work segment (rep or km), s/km. */
  fastest: number | null;
  slowest: number | null;
  /** Sessions only. */
  session: boolean;
  /** A run outside the plan: the training zone its work was judged against. */
  autoZone?: string;
}

const TOLERANCE = 3; // s/km either side of the range still counts as on point

/** "3:46–3:50" → [226, 230]; "4:05" → [222, 248]? no: a single pace gets ±3 s. */
export function paceRange(text: string | null): [number, number] | null {
  if (!text) return null;
  const m = /(\d:\d{2})(?:\s*[–-]\s*(\d:\d{2}))?/.exec(text);
  if (!m) return null;
  const a = parseTime(m[1])!;
  const b = m[2] ? parseTime(m[2])! : a;
  return [Math.min(a, b), Math.max(a, b)];
}

/** Work distance in a session's text, km: "5 × 1 km", "6 × 3 min", "last 6 at", "16 at", "25 min T". */
export function workKm(text: string, pace: number): { km: number; rep: number | null } | null {
  const reps = /(\d+)\s*×\s*([\d.,]+)\s*(km|m|min|s)\b/.exec(text);
  if (reps) {
    const n = +reps[1];
    const size = parseFloat(reps[2].replace(",", ""));
    const repKm = reps[3] === "km" ? size : reps[3] === "m" ? size / 1000 : reps[3] === "min" ? (size * 60) / pace : size / pace;
    return { km: n * repKm, rep: repKm };
  }
  const seg = /(?:last\s+)?(\d+(?:\.\d+)?)\s*(?:km\s*)?at\b/i.exec(text);
  if (seg && !/^\d+(?:\.\d+)?\s*km\s*$/i.test(seg[0])) return { km: +seg[1], rep: null };
  const tempo = /(\d+)\s*min\s*T\b/i.exec(text);
  if (tempo) return { km: (+tempo[1] * 60) / pace, rep: null };
  return null;
}

function verdictFor(off: number, easy: boolean): PaceVerdict {
  if (off === 0 || (easy && off > 0)) return "on-point";
  if (off < 0) return off >= -6 ? "slightly-fast" : "too-fast";
  return off <= 6 ? "slightly-slow" : "too-slow";
}

const offBy = (actual: number, [lo, hi]: [number, number]) => (actual < lo - TOLERANCE ? actual - (lo - TOLERANCE) : actual > hi + TOLERANCE ? actual - (hi + TOLERANCE) : 0);

export function checkRun(day: ForecastDay, run: Run, detail: RunDetail | null): PaceCheck | null {
  if (day.kind === "rest" || day.kind === "race") return null;
  const target = paceRange(day.pace);
  if (!target || run.distance < 1500) return null;
  const easy = day.kind === "easy" || (day.kind === "long" && !/\bat\s+\d:\d\d/.test(day.text));
  const ranKm = run.distance / 1000;
  const base = { runId: run.id, date: run.date, target, plannedKm: day.km, ranKm, fastest: null as number | null, slowest: null as number | null, session: false };

  if (easy) {
    const actual = run.moving_time / ranKm;
    const off = offBy(actual, target);
    const verdict = verdictFor(off, true);
    return { ...base, measured: "whole run", actual, off, verdict, score: verdict === "on-point" ? 100 : Math.max(0, Math.round(100 + off * 5)), inRange: null };
  }

  // A session with work at a pace: find the work.
  const mid = (target[0] + target[1]) / 2;
  const work = workKm(day.text, mid);
  if (!detail) return null;
  let segs: { distance: number; time: number }[] = [];
  let measured = "";
  const laps = detail.laps ?? [];
  if (work?.rep && laps.length >= 3) {
    // Watch laps that look like reps: about the right length and clearly quicker than easy.
    const rep = work.rep * 1000;
    const like = laps.filter((l) => l.distance > rep * 0.7 && l.distance < rep * 1.3 && l.moving_time / (l.distance / 1000) < mid * 1.12);
    if (like.length >= 2) {
      segs = like.map((l) => ({ distance: l.distance, time: l.moving_time }));
      measured = `${like.length} work laps`;
    }
  }
  if (!segs.length) {
    if (work?.rep != null && work.rep < 0.9) return null; // short reps can't be seen in km splits
    const kms = detail.splits.filter((s) => s.distance > 900).map((s) => ({ distance: s.distance, time: s.distance / (s.gap ?? s.speed) }));
    const n = Math.max(1, Math.min(kms.length, Math.round(work?.km ?? Math.min(5, kms.length))));
    segs = [...kms].sort((a, b) => a.time / a.distance - b.time / b.distance).slice(0, n);
    measured = n === 1 ? "fastest km" : `fastest ${n} km`;
  }
  if (!segs.length) return null;
  const dist = segs.reduce((s, x) => s + x.distance, 0);
  const actual = segs.reduce((s, x) => s + x.time, 0) / (dist / 1000);
  const inRange = segs.filter((x) => offBy(x.time / (x.distance / 1000), target) === 0).length / segs.length;
  const off = offBy(actual, target);
  const verdict = verdictFor(off, false);
  const score = Math.round(Math.max(0, Math.min(100, 0.5 * inRange * 100 + 0.5 * Math.max(0, 100 - Math.abs(off) * 6))));
  const paces = segs.map((x) => x.time / (x.distance / 1000));
  return { ...base, measured, actual, off, verdict, score, inRange, fastest: Math.min(...paces), slowest: Math.max(...paces), session: true };
}

/** Checks for every run on a planned day (several runs on one day: the longest). */
export function checkDays(days: ForecastDay[], details: Map<string, RunDetail>): Map<string, PaceCheck> {
  const out = new Map<string, PaceCheck>();
  for (const d of days) {
    if (!d.runs.length) continue;
    const run = [...d.runs].sort((a, b) => b.distance - a.distance)[0];
    const c = checkRun(d, run, details.get(run.id) ?? null);
    if (c) out.set(run.id, c);
  }
  return out;
}

export const VERDICT_LABEL: Record<PaceVerdict, string> = {
  "on-point": "On point",
  "slightly-fast": "A bit fast",
  "too-fast": "Too fast",
  "slightly-slow": "A bit slow",
  "too-slow": "Too slow",
};

export const fmtPace = (secs: number) => {
  const s = Math.round(secs); // round first, so 239.6 reads 4:00, not 3:60
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * A quick run that wasn't a planned session (before the plan started, or an
 * unplanned workout): its work is the laps (or km) clearly quicker than easy,
 * judged against the nearest of the plan's training paces.
 */
export function checkUnplanned(run: Run, detail: RunDetail | null, zones: { zone: string; now: string }[]): PaceCheck | null {
  if (!detail || run.workout_type === 1 || run.distance < 4000) return null;
  const easy = paceRange(zones.find((z) => /^easy/i.test(z.zone))?.now ?? null);
  const quick = (easy ? easy[0] : 300) - 25;
  const laps = (detail.laps ?? []).filter((l) => l.distance >= 300);
  let segs = laps.length >= 3 ? laps.map((l) => ({ distance: l.distance, time: l.moving_time })) : [];
  let measured = "quick laps";
  if (!segs.length) {
    segs = detail.splits.filter((x) => x.distance > 900).map((x) => ({ distance: x.distance, time: x.distance / (x.gap ?? x.speed) }));
    measured = "quick km";
  }
  const work = segs.filter((x) => x.time / (x.distance / 1000) < quick);
  if (work.length < 2 || work.length > segs.length * 0.85) return null; // a steady run, not a session
  const paces = work.map((x) => x.time / (x.distance / 1000));
  const median = [...paces].sort((a, b) => a - b)[Math.floor(paces.length / 2)];
  const zone = zones
    .map((z) => ({ z, r: paceRange(z.now) }))
    .filter((x): x is { z: { zone: string; now: string }; r: [number, number] } => !!x.r && x.r[0] < quick)
    .sort((a, b) => Math.abs((a.r[0] + a.r[1]) / 2 - median) - Math.abs((b.r[0] + b.r[1]) / 2 - median))[0];
  if (!zone) return null;
  const target = zone.r;
  const dist = work.reduce((a, x) => a + x.distance, 0);
  const actual = work.reduce((a, x) => a + x.time, 0) / (dist / 1000);
  const inRange = work.filter((x) => offBy(x.time / (x.distance / 1000), target) === 0).length / work.length;
  const off = offBy(actual, target);
  const verdict = verdictFor(off, false);
  const score = Math.round(Math.max(0, Math.min(100, 0.5 * inRange * 100 + 0.5 * Math.max(0, 100 - Math.abs(off) * 6))));
  return {
    runId: run.id,
    date: run.date,
    target,
    plannedKm: null,
    ranKm: run.distance / 1000,
    measured: `${work.length} ${measured}`,
    actual,
    off,
    verdict,
    score,
    inRange,
    fastest: Math.min(...paces),
    slowest: Math.max(...paces),
    session: true,
    autoZone: zone.z.zone,
  };
}
