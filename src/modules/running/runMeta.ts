import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import type { Run } from "./strava";

/**
 * What you add to a run after it (the Strava-style "how was it?"): a title,
 * notes, how it felt, how hard it was, and the shoes you wore. Kept with your
 * data (synced between phone and PC); a new title and notes also go to Garmin.
 */
export type Feel = "great" | "good" | "ok" | "tired" | "rough";
export const FEELS: { id: Feel; label: string; face: string }[] = [
  { id: "great", label: "Great", face: "😄" },
  { id: "good", label: "Good", face: "🙂" },
  { id: "ok", label: "OK", face: "😐" },
  { id: "tired", label: "Tired", face: "😮‍💨" },
  { id: "rough", label: "Rough", face: "😣" },
];
export interface RunMeta {
  name?: string;
  notes?: string;
  feel?: Feel;
  /** Effort, 1 (very easy) to 10 (all out). */
  rpe?: number;
  shoe?: string | null;
  /** You've seen (and saved or skipped) the review. */
  reviewed?: boolean;
  /** The review has opened by itself once (it never opens by itself again). */
  seen?: boolean;
}
const key = (id: string) => `run.meta.${id}`;
export const loadRunMeta = (id: string) => kvGet<RunMeta>(key(id), {});
export async function saveRunMeta(id: string, m: RunMeta) {
  await kvSet(key(id), m);
  await notifyChanged("running");
}
export async function loadAllRunMeta(): Promise<Map<string, RunMeta>> {
  const rows = await db.select<{ key: string; value: string }>("SELECT key, value FROM kv WHERE key LIKE 'run.meta.%'");
  const out = new Map<string, RunMeta>();
  for (const r of rows)
    try {
      out.set(r.key.slice(9), JSON.parse(r.value));
    } catch {
      /* skip */
    }
  return out;
}

/** The newest run (last two days) you haven't reviewed: opened by itself when the app opens, like Strava. */
export async function runToReview(runs: Run[], today: string): Promise<Run | null> {
  const from = new Date(Date.parse(today) - 2 * 86400000).toISOString().slice(0, 10);
  const recent = runs.filter((r) => r.date >= from).sort((a, b) => (a.start_local < b.start_local ? 1 : -1));
  for (const r of recent.slice(0, 1)) {
    if (seenHere(r.id)) continue;
    const m = await loadRunMeta(r.id);
    if (!m.reviewed && !m.seen) return r;
  }
  return null;
}

/** Shown once: remembered with the run (so other devices know) and on this device straight away. */
export async function markSeen(id: string) {
  try {
    localStorage.setItem(`cc-review-seen-${id}`, "1");
  } catch {
    /* private mode */
  }
  const m = await loadRunMeta(id);
  if (!m.seen) await saveRunMeta(id, { ...m, seen: true });
}
function seenHere(id: string) {
  try {
    return localStorage.getItem(`cc-review-seen-${id}`) === "1";
  } catch {
    return false;
  }
}

/** A new title and notes go to Garmin Connect too (Garmin runs); false when that couldn't be done. */
export async function sendToGarmin(run: Run, name: string, notes: string): Promise<boolean> {
  if (!run.id.startsWith("g")) return false;
  const id = Number(run.id.slice(1));
  try {
    const r = await backend.garminWrite("PUT", `/activity-service/activity/${id}`, { activityId: id, activityName: name, description: notes || null });
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}

// ---- Your shoes ----------------------------------------------------------------------

export interface MyShoe {
  id: string;
  name: string;
  /** Kilometres already on them when added. */
  startKm: number;
  /** When to think about replacing them. */
  limitKm: number;
  retired?: boolean;
  /** Picked for new runs unless you choose others. */
  isDefault?: boolean;
}
export const loadMyShoes = () => kvGet<MyShoe[]>("gear.shoes", []);
export async function saveMyShoes(s: MyShoe[]) {
  await kvSet("gear.shoes", s);
  await notifyChanged("running");
}
/** Kilometres on each shoe: what it had when added plus every run you wore it on. */
export function shoeKm(shoes: MyShoe[], runs: Run[], metas: Map<string, RunMeta>): Map<string, number> {
  const out = new Map(shoes.map((s) => [s.id, s.startKm]));
  for (const r of runs) {
    const s = metas.get(r.id)?.shoe;
    if (s && out.has(s)) out.set(s, out.get(s)! + r.distance / 1000);
  }
  return out;
}
