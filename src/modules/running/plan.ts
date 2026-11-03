import { backend } from "@backend";
import { addDays, diffDays, parseKey } from "../../core/time";
import defaultPlan from "./default-plan.json";
import type { PlanAdjust } from "./planAdjust";

export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export const WEEK_KEYS: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface PlanWeek {
  week: string;
  start: string;
  end: string;
  phase: string;
  km: string;
  kmMin: number | null;
  kmMax: number | null;
  /** Named sessions by day; days without one follow the weekly structure. */
  sessions: Partial<Record<DayKey, string>>;
  notes: string;
}
export interface PlanRace {
  date: string | null;
  approx: boolean;
  when: string;
  name: string;
  target: string;
  role: string;
}
export interface Benchmark {
  name: string;
  date: string | null;
  when: string;
  onTrack: string;
  behind: string;
}
export interface Plan {
  version: number;
  title: string;
  exported: string;
  source: string;
  phases: { name: string; start: string | null; end: string | null; summary?: string }[];
  blocks: { name: string; start: string | null; end: string | null; km: string; kmMin: number | null; kmMax: number | null; key: string; race: string }[];
  races: PlanRace[];
  weeks: PlanWeek[];
  paces: { zone: string; now: string; autumn: string; hr: string; use: string }[];
  structure: { day: string; phases12: string; phase3: string }[];
  strength: { A: string[]; B: string[] };
  rules: string[];
  benchmarks: Benchmark[];
  /** Set once the plan has been edited in the app; it's then the master copy. */
  editedInApp?: string;
  /** Your settings on top of the plan (mileage, long runs, run days). Applied when loaded. */
  adjust?: PlanAdjust | null;
  /** The weeks as written, before `adjust` (only on a loaded plan; never saved). */
  baseWeeks?: PlanWeek[];
  /** Past races to show on the progression page (Strava activity ids). */
  history?: { races: { id: string; name: string; km: number }[]; marathons: { name: string; date: string }[] };
}

export const PLAN_FILE = "training-plan.json";
export const BUNDLED_PLAN = defaultPlan as unknown as Plan;

/**
 * Reads training-plan.json from the data folder. On first run the plan that
 * ships with the app is written there, so it can be replaced by a fresh export.
 */
export async function loadPlan(): Promise<{ plan: Plan; error: string | null }> {
  const r = await loadPlanFile();
  if (!r.plan.adjust) return r;
  // Imported here, not at the top: planAdjust uses the forecast, which uses this file.
  const { applyAdjust } = await import("./planAdjust");
  try {
    return { ...r, plan: applyAdjust(r.plan) };
  } catch (e) {
    return { ...r, error: `Your plan settings couldn't be applied (${(e as Error).message}); showing the plan as written.` };
  }
}

/** The plan as written in training-plan.json, without your settings applied. */
export async function loadPlanFile(): Promise<{ plan: Plan; error: string | null }> {
  const text = await backend.readDataFile(PLAN_FILE);
  if (text == null) {
    await backend.writeDataFile(PLAN_FILE, JSON.stringify(BUNDLED_PLAN, null, 2));
    return { plan: BUNDLED_PLAN, error: null };
  }
  try {
    const plan = JSON.parse(text) as Plan;
    if (!Array.isArray(plan.weeks) || !Array.isArray(plan.races)) throw new Error("missing weeks or races");
    // An app update carrying a newer export of the plan replaces the older copy.
    // (Not once you've edited the plan in the app: then your version is the master copy.)
    if (!plan.editedInApp && (BUNDLED_PLAN.exported ?? "") > (plan.exported ?? "")) {
      await backend.writeDataFile(PLAN_FILE, JSON.stringify(BUNDLED_PLAN, null, 2));
      return { plan: BUNDLED_PLAN, error: null };
    }
    return { plan: { ...plan, history: plan.history ?? BUNDLED_PLAN.history }, error: null };
  } catch (e) {
    // A half-edited file shouldn't blank the card: keep showing the bundled plan.
    return { plan: BUNDLED_PLAN, error: `training-plan.json couldn't be read (${(e as Error).message}); showing the built-in plan.` };
  }
}

export function weekFor(plan: Plan, day: string): PlanWeek | null {
  return plan.weeks.find((w) => w.start <= day && day <= w.end) ?? null;
}

export function blockFor(plan: Plan, day: string) {
  return plan.blocks.find((b) => b.start && b.end && b.start <= day && day <= b.end) ?? null;
}

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** What the plan says for a given day: the week's named session, else the weekly structure. */
export function sessionFor(plan: Plan, day: string): { text: string; key: boolean } | null {
  const w = weekFor(plan, day);
  const dow = parseKey(day).getDay();
  const key = DAY_KEYS[dow];
  if (w) {
    const named = w.sessions[key as keyof PlanWeek["sessions"]];
    if (named) return { text: named, key: true };
    // In phase 3 the mid-week quality moves to Wednesday, so Thursday is easy, and vice versa.
    const phase3 = /phase 3/i.test(w.phase);
    const row = plan.structure.find((s) => s.day.toLowerCase().startsWith(DAY_NAMES[dow].toLowerCase()));
    if (row) return { text: phase3 ? row.phase3 : row.phases12, key: false };
  }
  return null;
}

export interface RaceCountdown extends PlanRace {
  days: number;
}

export function upcomingRaces(plan: Plan, today: string): RaceCountdown[] {
  return plan.races
    .filter((r) => r.date && r.date >= today)
    .map((r) => ({ ...r, days: diffDays(today, r.date!) }))
    .sort((a, b) => a.days - b.days);
}

/** Monday of the week containing `day`. */
export function mondayOf(day: string): string {
  const dow = parseKey(day).getDay();
  return addDays(day, -((dow + 6) % 7));
}

export function planWeekNumber(plan: Plan, day: string): { label: string; index: number; total: number } | null {
  const i = plan.weeks.findIndex((w) => w.start <= day && day <= w.end);
  if (i < 0) return null;
  return { label: plan.weeks[i].week, index: i, total: plan.weeks.length };
}

/** "55", "70–80", "about 35 + race" → [min, max]. */
export function kmRange(text: string): [number | null, number | null] {
  const m = /(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?/.exec(text);
  if (!m) return [null, null];
  return [+m[1], m[2] ? +m[2] : +m[1]];
}

/** Saves a plan edited in the app; from then on it's the master copy. */
export async function savePlan(plan: Plan) {
  const today = new Date().toISOString().slice(0, 10);
  const weeks = (plan.baseWeeks ?? plan.weeks).map((w) => {
    const [lo, hi] = kmRange(w.km);
    return { ...w, kmMin: lo, kmMax: hi, end: addDays(w.start, 6) };
  });
  const { baseWeeks: _b, ...rest } = plan;
  const out: Plan = { ...rest, weeks, editedInApp: new Date().toISOString(), exported: plan.exported > today ? plan.exported : today };
  await backend.writeDataFile(PLAN_FILE, JSON.stringify(out, null, 2));
  window.dispatchEvent(new Event("cc:plan-changed"));
}

/** Throws away in-app edits and goes back to the plan from your doc (as shipped with the app). */
export async function resetPlan() {
  await backend.writeDataFile(PLAN_FILE, JSON.stringify(BUNDLED_PLAN, null, 2));
  window.dispatchEvent(new Event("cc:plan-changed"));
}

/** Saves your plan settings (null = back to the plan as written). Keeps the plan itself as it is. */
export async function savePlanAdjust(adjust: PlanAdjust | null) {
  const { plan } = await loadPlanFile();
  const out: Plan = { ...plan, adjust };
  await backend.writeDataFile(PLAN_FILE, JSON.stringify(out, null, 2));
  window.dispatchEvent(new Event("cc:plan-changed"));
}
