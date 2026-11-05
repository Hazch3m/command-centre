import { kvGet, kvSet } from "../../core/db";
import { parseTime } from "./stats";

/**
 * How runs are targeted and judged: by pace or by heart rate, how precise
 * easy-run targets are, and whether easy runs get "too fast / too slow"
 * verdicts at all. Kept in the app's settings (not the plan), applied when
 * the plan loads, so it changes every view at once.
 */
export interface RunPrefs {
  mode: "pace" | "hr";
  /** Easy, long and recovery runs: the plan's range, a wider one, or just "by feel". */
  easyTarget: "exact" | "wide" | "feel";
  /** Verdicts (too fast, too slow…) on easy, long and recovery runs. */
  easyChecks: boolean;
}
export const DEFAULT_PREFS: RunPrefs = { mode: "pace", easyTarget: "wide", easyChecks: false };
export const PREFS_KEY = "running.prefs";

export async function loadRunPrefs(): Promise<RunPrefs> {
  return { ...DEFAULT_PREFS, ...(await kvGet<Partial<RunPrefs>>(PREFS_KEY, {})) };
}
export async function saveRunPrefs(p: RunPrefs) {
  await kvSet(PREFS_KEY, p);
  window.dispatchEvent(new Event("cc:plan-changed"));
}

/** Heart-rate zones by the plan's pace names ("Easy", "Threshold (T)"…), [low, high] bpm. */
export type HrZones = { zone: string; range: [number, number] }[];

/** % of heart-rate reserve for each training zone (Karvonen), when the plan doesn't give heart rates. */
const HRR: [RegExp, number, number][] = [
  [/^recovery/i, 0.5, 0.65],
  [/^easy/i, 0.62, 0.75],
  [/^long/i, 0.66, 0.78],
  [/^marathon/i, 0.78, 0.86],
  [/^half/i, 0.84, 0.89],
  [/^threshold/i, 0.86, 0.91],
  [/^10k/i, 0.89, 0.94],
  [/^5k|vo2/i, 0.92, 0.98],
];

/** The plan's heart-rate column where it has one ("130–148", "under 135"), else zones from max and resting heart rate. */
export function hrZones(paces: { zone: string; hr: string }[], hrMax: number, hrRest: number): HrZones {
  const out: HrZones = [];
  for (const p of paces) {
    const m = /(\d{2,3})\s*[–-]\s*(\d{2,3})/.exec(p.hr ?? "");
    const under = /under\s+(\d{2,3})/i.exec(p.hr ?? "");
    let range: [number, number] | null = m ? [+m[1], +m[2]] : under ? [Math.round(hrRest + 0.45 * (hrMax - hrRest)), +under[1]] : null;
    if (!range) {
      const z = HRR.find(([re]) => re.test(p.zone));
      if (z) range = [Math.round(hrRest + z[1] * (hrMax - hrRest)), Math.round(hrRest + z[2] * (hrMax - hrRest))];
    }
    if (range) out.push({ zone: p.zone, range });
  }
  return out;
}

const fmt = (s: number) => {
  const r = Math.round(s);
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, "0")}`;
};

/** "5:00–5:40" → "4:45–5:55" (15 s either way): room for hills, heat and tired legs. */
export function widen(range: string, by = 15): string {
  const m = /(\d:\d{2})\s*[–-]\s*(\d:\d{2})/.exec(range);
  if (!m) return range;
  return `${fmt(parseTime(m[1])! - by)}–${fmt(parseTime(m[2])! + by)}`;
}

export const hrText = ([lo, hi]: [number, number]) => `${lo}–${hi} bpm`;

/** "130–148 bpm" → [130, 148]. */
export function hrRange(text: string | null): [number, number] | null {
  const m = /(\d{2,3})\s*[–-]\s*(\d{2,3})\s*bpm/.exec(text ?? "");
  return m ? [+m[1], +m[2]] : null;
}
