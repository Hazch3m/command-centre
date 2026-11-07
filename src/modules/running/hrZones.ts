import { kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";

/**
 * Heart-rate zones: Garmin's own (what your watch shows) when we have them, otherwise worked
 * out from your max heart rate, heart-rate reserve or lactate threshold, the way you choose.
 */
export type ZoneMethod = "garmin" | "max" | "reserve" | "lthr";
export const ZONE_METHODS: { id: ZoneMethod; label: string; hint: string }[] = [
  { id: "garmin", label: "Garmin", hint: "The zones set on your watch" },
  { id: "max", label: "% of max", hint: "50, 60, 70, 80, 90% of max heart rate" },
  { id: "reserve", label: "% of reserve", hint: "Heart-rate reserve (Karvonen): uses your resting heart rate too" },
  { id: "lthr", label: "Threshold", hint: "From your lactate threshold heart rate (Friel)" },
];
export interface ZoneSettings {
  method: ZoneMethod;
  hrMax?: number;
  hrRest?: number;
  lthr?: number;
}
/** Garmin's zones for running (from biometric-service), saved at each health sync. */
export interface GarminZones {
  method: string;
  floors: number[];
  max: number;
  rest?: number;
  lthr?: number;
}
export interface Zones {
  /** Bottom of zones 1 to 5, in bpm. */
  floors: number[];
  max: number;
  rest?: number;
  lthr?: number;
  method: ZoneMethod;
  /** Where the numbers come from, in words. */
  source: string;
}
export const ZONE_NAMES = ["Warm-up", "Easy", "Aerobic", "Threshold", "Maximum"] as const;

export const loadZoneSettings = () => kvGet<ZoneSettings | null>("hr.zones", null);
export async function saveZoneSettings(s: ZoneSettings) {
  await kvSet("hr.zones", s);
  await notifyChanged("running");
}
export const loadGarminZones = () => kvGet<GarminZones | null>("health.hrZones", null);

const GARMIN_METHOD: Record<string, string> = {
  HR_MAX_BASED: "% of max",
  HR_RESERVE_BASED: "% of heart-rate reserve",
  LACTATE_THRESHOLD_BASED: "% of threshold",
};

/** Garmin's answer (a list, one per sport): running's if set, else the default. */
export function parseGarminZones(body: unknown): GarminZones | null {
  if (!Array.isArray(body)) return null;
  const rows = body as Record<string, unknown>[];
  const r = rows.find((x) => x.sport === "RUNNING") ?? rows.find((x) => x.sport === "DEFAULT") ?? rows[0];
  if (!r) return null;
  const floors = [1, 2, 3, 4, 5].map((i) => Number(r[`zone${i}Floor`]));
  const max = Number(r.maxHeartRateUsed);
  if (floors.some((f) => !(f > 40 && f < 230)) || !(max > 120 && max < 240)) return null;
  const num = (v: unknown) => (typeof v === "number" && v > 30 ? v : undefined);
  return { method: String(r.trainingMethod ?? ""), floors, max, rest: num(r.restingHeartRateUsed), lthr: num(r.lactateThresholdHeartRateUsed) };
}

/** The zones in use. `fallback` is the max and resting heart rate the app already knows. */
export function resolveZones(s: ZoneSettings | null, g: GarminZones | null, fallback: { hrMax: number; hrRest: number }): Zones {
  const method: ZoneMethod = s?.method ?? (g ? "garmin" : "max");
  if (method === "garmin" && g) return { floors: g.floors, max: g.max, rest: g.rest, lthr: g.lthr, method, source: `From Garmin Connect (${GARMIN_METHOD[g.method] ?? "your settings"})` };
  const max = s?.hrMax ?? g?.max ?? fallback.hrMax;
  const rest = s?.hrRest ?? g?.rest ?? fallback.hrRest;
  const lthr = s?.lthr ?? g?.lthr ?? Math.round(max * 0.9);
  const pct = [0.5, 0.6, 0.7, 0.8, 0.9];
  if (method === "reserve") return { floors: pct.map((p) => Math.round(rest + p * (max - rest))), max, rest, method, source: `Heart-rate reserve: max ${max}, resting ${rest}` };
  if (method === "lthr") return { floors: [0.7, 0.85, 0.9, 0.95, 1].map((p) => Math.round(lthr * p)), max, lthr, method, source: `Threshold ${lthr} bpm` };
  const m = method === "garmin" ? "max" : method;
  return { floors: pct.map((p) => Math.round(p * max)), max, method: m, source: `% of max heart rate ${max}${s?.hrMax ? "" : g ? " (Garmin)" : " (from your runs)"}` };
}

/** Zone 1–5 of a heart rate (below zone 1 counts as zone 1). */
export function zoneOf(bpm: number, z: Pick<Zones, "floors">): number {
  let n = 1;
  for (let i = 0; i < 5; i++) if (bpm >= z.floors[i]) n = i + 1;
  return n;
}

/** "120–139" style ranges for each zone. */
export function zoneRanges(z: Pick<Zones, "floors" | "max">): string[] {
  return z.floors.map((f, i) => (i === 0 ? `< ${z.floors[1]}` : i === 4 ? `${f}+` : `${f}–${z.floors[i + 1] - 1}`));
}
