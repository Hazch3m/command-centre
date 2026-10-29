import { backend } from "@backend";
import { addDays, diffDays, parseKey } from "../../core/time";
import defaultPlan from "./default-plan.json";

export interface PlanWeek {
  week: string;
  start: string;
  end: string;
  phase: string;
  km: string;
  kmMin: number | null;
  kmMax: number | null;
  sessions: Partial<Record<"tue" | "wed" | "thu" | "sun", string>>;
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
  const text = await backend.readDataFile(PLAN_FILE);
  if (text == null) {
    await backend.writeDataFile(PLAN_FILE, JSON.stringify(BUNDLED_PLAN, null, 2));
    return { plan: BUNDLED_PLAN, error: null };
  }
  try {
    const plan = JSON.parse(text) as Plan;
    if (!Array.isArray(plan.weeks) || !Array.isArray(plan.races)) throw new Error("missing weeks or races");
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
