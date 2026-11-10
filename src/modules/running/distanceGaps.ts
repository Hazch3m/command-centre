import { addDays } from "../../core/time";
import type { Run, RunDetail } from "./strava";
import { predictTime } from "./vo2";

/**
 * For each race distance: the pace your VO2 max says you could run it at, your best stretch of
 * that length lately, your longest run, and how much you've run near that pace. Together they
 * say what's missing: endurance (mileage) or pace-specific work.
 */
export interface DistanceGap {
  name: string;
  meters: number;
  /** s/km your fitness is worth over this distance. */
  eqPace: number;
  /** Your fastest stretch this long in the last 12 weeks (s/km), if a run was long enough. */
  bestPace: number | null;
  bestDate: string | null;
  /** best − equivalent, s/km (positive: slower than your fitness says). */
  gap: number | null;
  longestKm: number;
  needLongKm: number;
  /** 5K/10K: km within a few % of the equivalent pace in the last 6 weeks. Half/marathon: the longest
   * unbroken stretch at that pace in one run (8 weeks): long races need it held, not just touched. */
  paceKm: number;
  needPaceKm: number;
  paceMode: "total" | "block";
  verdict: "ok" | "mileage" | "pace" | "both";
}

const DISTANCES: { name: string; meters: number; long: number; pace: number; mode: "total" | "block" }[] = [
  { name: "5K", meters: 5000, long: 10, pace: 12, mode: "total" },
  { name: "10K", meters: 10000, long: 15, pace: 20, mode: "total" },
  { name: "Half marathon", meters: 21097.5, long: 20, pace: 8, mode: "block" },
  { name: "Marathon", meters: 42195, long: 32, pace: 16, mode: "block" },
];

/** Longest run of consecutive splits inside the pace band, in km. */
function longestBlock(splits: RunDetail["splits"], lo: number, hi: number): number {
  let best = 0;
  let cur = 0;
  for (const x of splits) {
    if (x.distance < 200 || !x.moving_time) continue;
    const p = x.moving_time / (x.distance / 1000);
    if (p >= lo && p <= hi) cur += x.distance / 1000;
    else cur = 0;
    best = Math.max(best, cur);
  }
  return best;
}

/** Fastest stretch of at least `meters` from a run's km splits, as s/km. */
export function bestStretch(splits: RunDetail["splits"], meters: number): number | null {
  const s = splits.filter((x) => x.distance > 50 && x.moving_time > 0);
  let best: number | null = null;
  for (let i = 0; i < s.length; i++) {
    let d = 0;
    let t = 0;
    for (let j = i; j < s.length; j++) {
      d += s[j].distance;
      t += s[j].moving_time;
      if (d >= meters * 0.98) {
        const p = t / (d / 1000);
        if (best == null || p < best) best = p;
        break;
      }
    }
  }
  return best;
}

export function distanceGaps(runs: Run[], details: Map<string, RunDetail>, vdot: number, today: string): DistanceGap[] {
  const since12 = addDays(today, -84);
  const since6 = addDays(today, -42);
  const since8 = addDays(today, -56);
  const recent = runs.filter((r) => r.date >= since12 && r.date <= today);
  const longestKm = recent.reduce((a, r) => Math.max(a, r.distance / 1000), 0);
  return DISTANCES.map((D) => {
    const eqPace = predictTime(D.meters, vdot) / (D.meters / 1000);
    let bestPace: number | null = null;
    let bestDate: string | null = null;
    let paceKm = 0;
    for (const r of recent) {
      const sp = details.get(r.id)?.splits ?? [];
      if (r.distance >= D.meters * 0.98) {
        const p = sp.length ? bestStretch(sp, D.meters) : r.moving_time / (r.distance / 1000);
        if (p != null && (bestPace == null || p < bestPace)) [bestPace, bestDate] = [p, r.date];
      }
      if (D.mode === "block") {
        if (r.date >= since8) paceKm = Math.max(paceKm, longestBlock(sp, eqPace * 0.95, eqPace * 1.03));
      } else if (r.date >= since6)
        for (const x of sp) {
          if (x.distance < 200 || !x.moving_time) continue;
          const p = x.moving_time / (x.distance / 1000);
          if (p <= eqPace * 1.03 && p >= eqPace * 0.92) paceKm += x.distance / 1000;
        }
    }
    const gap = bestPace != null ? bestPace - eqPace : null;
    const shortLong = longestKm < D.long * 0.9;
    const shortPace = paceKm < D.pace * (D.mode === "block" ? 0.75 : 0.5) || (gap != null && gap / eqPace > 0.05);
    const verdict = shortLong && shortPace ? "both" : shortLong ? "mileage" : shortPace ? "pace" : "ok";
    return { name: D.name, meters: D.meters, eqPace, bestPace, bestDate, gap, longestKm, needLongKm: D.long, paceKm, needPaceKm: D.pace, paceMode: D.mode, verdict };
  });
}

export const VERDICT_TEXT: Record<DistanceGap["verdict"], string> = { ok: "On it", mileage: "Needs mileage", pace: "Needs pace work", both: "Needs both" };

/** One line: which distances need what. */
export function gapSummary(gs: DistanceGap[]): string {
  const by = (v: DistanceGap["verdict"]) => gs.filter((g) => g.verdict === v || g.verdict === "both" && v !== "ok").map((g) => g.name);
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const m = by("mileage");
  const p = by("pace");
  const ok = gs.filter((g) => g.verdict === "ok").map((g) => g.name);
  const parts = [m.length ? `${list(m)}: more mileage (longer long runs)` : "", p.length ? `${list(p)}: more running at race pace` : "", ok.length ? `${list(ok)}: on track` : ""].filter(Boolean);
  return parts.join(" · ");
}
