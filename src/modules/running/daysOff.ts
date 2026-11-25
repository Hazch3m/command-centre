import { addDays } from "../../core/time";
import type { ForecastDay } from "./forecast";

/*
 * Days off in a week ("I can't run from Friday evening"): the week's sessions are fitted into the days you can
 * run, following the plan's weekly rules (spec v1.2, step 4):
 *  - the long run goes on the latest day you can run;
 *  - key sessions stay at least 48 h apart (a day between them), earliest first; a key session straight before
 *    the long run is allowed only when there's no other day (and said so); if they still can't fit, key 2 is
 *    dropped first;
 *  - the easy km left over are shared across the other free days (at most 22 km a day); what doesn't fit is said;
 *  - days already run, races, and days before today don't move.
 * Nothing is saved here: the result is a set of day changes for you to confirm (saved as your day edits, which
 * "Put this week back as planned" clears).
 */

export interface DaysOffResult {
  /** New text for each day that changes. */
  changes: Map<string, string>;
  notes: string[];
  /** Planned km for the movable days, before and after. */
  before: number;
  after: number;
}

const KM = /^(\d+(?:\.\d+)?) km/;
const kmOf = (d: ForecastDay) => d.km ?? Number(KM.exec(d.text)?.[1] ?? 0);
const MAX_EASY = 22;
const dayName = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });

export function fitAroundDaysOff(days: ForecastDay[], off: Set<string>, today: string): DaysOffResult {
  const movable = days.filter((d) => d.date >= today && !d.runs.length && !d.race);
  const fixed = new Set(days.filter((d) => !movable.includes(d)).map((d) => d.date));
  const can = movable.filter((d) => !off.has(d.date)).map((d) => d.date);
  const notes: string[] = [];
  const before = movable.reduce((a, d) => a + kmOf(d), 0);
  const changes = new Map<string, string>();
  if (!movable.some((d) => off.has(d.date))) return { changes, notes, before: Math.round(before), after: Math.round(before) };
  const plan = new Map<string, string>();
  for (const d of movable) if (off.has(d.date) && d.kind !== "rest") plan.set(d.date, "Rest");
  if (!can.length) {
    for (const [k, v] of plan) changes.set(k, v);
    return { changes, notes: ["No days left to run this week: the sessions are left out."], before, after: 0 };
  }

  const long = movable.find((d) => d.kind === "long");
  const keys = movable.filter((d) => d.kind === "key");
  const easyKm = movable.filter((d) => d.kind === "easy" || d.kind === "optional").reduce((a, d) => a + kmOf(d), 0);
  const strength = movable.some((d) => /strength/.test(d.text));
  const strides = movable.some((d) => /strides/.test(d.text));

  // Days taken by a session (including ones already run this week, which also count for spacing).
  const taken = new Map<string, "key" | "long">();
  for (const d of days) if (fixed.has(d.date) && (d.kind === "key" || d.kind === "long" || d.race)) taken.set(d.date, d.kind === "long" ? "long" : "key");

  let longDay: string | null = null;
  if (long) {
    longDay = can[can.length - 1];
    taken.set(longDay, "long");
    plan.set(longDay, long.text);
  }
  const near = (date: string, kind: "key" | "long") => [addDays(date, -1), addDays(date, 1)].some((x) => taken.get(x) === kind || (kind === "key" && taken.get(x) === "key"));
  for (const k of keys) {
    const free = can.filter((d) => !taken.has(d));
    // Best: a day clear of other key sessions and of the long run. Then: clear of key sessions, next to the long run.
    const pick = free.find((d) => !near(d, "key") && !near(d, "long")) ?? free.find((d) => !near(d, "key"));
    if (!pick) {
      notes.push(`Not enough days for every session: ${(/warm-up, (.+?) at /.exec(k.text)?.[1] ?? k.text.split(",")[0])} is left out (its distance goes on the easy days).`);
      continue;
    }
    if (longDay && (pick === addDays(longDay, -1) || pick === addDays(longDay, 1)))
      notes.push(`${dayName(pick)}'s session is next to the long run: keep it controlled, and the long run easy.`);
    taken.set(pick, "key");
    plan.set(pick, k.text);
  }

  // Easy km on the other days you can run.
  const droppedKm = keys.filter((k) => ![...plan.values()].includes(k.text)).reduce((a, k) => a + Math.max(0, kmOf(k) - 2), 0);
  let left = easyKm + droppedKm;
  const easyDays = can.filter((d) => !taken.has(d));
  if (easyDays.length) {
    const each = Math.min(MAX_EASY, Math.round(left / easyDays.length));
    easyDays.forEach((d, i) => {
      const km = i === easyDays.length - 1 ? Math.min(MAX_EASY, Math.max(0, Math.round(left))) : each;
      left -= km;
      if (km < 3) {
        plan.set(d, "Rest");
        left += km;
        return;
      }
      const add = [strides && i < 2 ? "6 × 20 s strides" : "", strength && i < 2 ? "20 min strength (calves, hamstrings, hips)" : ""].filter(Boolean);
      plan.set(d, `${km} km easy${add.length ? " + " + add.join(" + ") : ""}`);
    });
  }
  if (left >= 3) notes.push(`About ${Math.round(left)} km of easy running doesn't fit in the days left (at most ${MAX_EASY} km a day). Leave it out: a slightly shorter week is fine.`);

  const after = movable.reduce((a, d) => a + Number(KM.exec(plan.get(d.date) ?? "")?.[1] ?? 0), 0);
  for (const d of movable) {
    const t = plan.get(d.date) ?? "Rest";
    if (t !== (d.text || "Rest")) changes.set(d.date, t);
  }
  return { changes, notes, before: Math.round(before), after: Math.round(after) };
}
