import { kvGet, kvSet } from "../../core/db";
import { addDays, todayKey } from "../../core/time";
import { forecastWeek } from "../running/forecast";
import { loadPlan, mondayOf, type Plan } from "../running/plan";
import * as coach from "./coach";
import { toGarmin } from "./garminWorkouts";
import { sessionToWorkout, type Zones } from "./importWeek";

/**
 * Watch sync, like Runna's: with it on, the next days of your plan are kept
 * on your Garmin calendar as structured workouts. When the plan changes (a
 * day edited or moved, plan settings, a new plan, a race taper) the workouts
 * are updated, moved or removed to match. Only workouts this put there are
 * touched; ones you made yourself are left alone.
 *
 * It runs on the PC, or in the cloud when cloud sync is on (then it works
 * with the PC off, and the PC leaves it to the cloud).
 */

export interface AutoSyncSettings {
  on: boolean;
  /** How many days ahead to keep on the watch. */
  days: number;
}
export const AUTOSYNC_SETTINGS = "watch.autosync.settings";
export const AUTOSYNC_STATE = "watch.autosync";
export const getAutoSync = () => kvGet<AutoSyncSettings>(AUTOSYNC_SETTINGS, { on: false, days: 7 });
export async function setAutoSync(s: AutoSyncSettings) {
  await kvSet(AUTOSYNC_SETTINGS, s);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("cc:watch-sync"));
}

/** What's on Garmin because of this, by date. */
export interface Synced {
  workoutId: number;
  scheduleId: number;
  /** The workout as sent, to tell when the plan's version has changed. */
  hash: string;
  name: string;
}
export interface AutoSyncState {
  days: Record<string, Synced>;
  lastRun: string | null;
  lastError: string | null;
  /** What the last run did, in words. */
  lastResult: string | null;
}
export const getAutoSyncState = () => kvGet<AutoSyncState>(AUTOSYNC_STATE, { days: {}, lastRun: null, lastError: null, lastResult: null });

const zonesOf = (plan: Plan): Zones => {
  const z = (re: RegExp) => plan.paces.find((x) => re.test(x.zone))?.now;
  return { MP: z(/^Marathon pace/i), HMP: z(/^Half marathon pace/i), T: z(/^Threshold/i) };
};

/** The workouts the plan wants on the watch, by date. */
export function wanted(plan: Plan, from: string, days: number) {
  const out = new Map<string, { w: NonNullable<ReturnType<typeof sessionToWorkout>>; hash: string }>() as Map<string, { w: NonNullable<ReturnType<typeof sessionToWorkout>>; hash: string }> & { ran: Set<string> };
  out.ran = new Set<string>();
  const zones = zonesOf(plan);
  for (let m = mondayOf(from); m <= addDays(from, days - 1); m = addDays(m, 7)) {
    for (const d of forecastWeek(plan, m).days) {
      if (d.date < from || d.date > addDays(from, days - 1)) continue;
      // Rest days, races and days already run have nothing to send.
      if (d.runs.length) out.ran.add(d.date);
      if (d.kind === "rest" || d.race || d.kind === "race" || !(d.km ?? 0) || d.runs.length) continue;
      const w = sessionToWorkout(d.text, zones);
      if (!w) continue;
      try {
        out.set(d.date, { w, hash: JSON.stringify(toGarmin(w)) });
      } catch {
        /* a session the converter can't express: left for you to send by hand */
      }
    }
  }
  return out;
}

let running: Promise<AutoSyncState> | null = null;

/** Brings the Garmin calendar in line with the plan. Safe to call often: it only sends what changed. */
export function runAutoSync(opts: { force?: boolean } = {}): Promise<AutoSyncState> {
  running ??= doRun(opts).finally(() => (running = null));
  return running;
}

async function doRun({ force }: { force?: boolean }): Promise<AutoSyncState> {
  const settings = await getAutoSync();
  const state = await getAutoSyncState();
  const today = todayKey();
  // Past days stay on Garmin as history; just stop tracking them.
  for (const d of Object.keys(state.days)) if (d < today) delete state.days[d];
  if (!settings.on) return state;
  const done: string[] = [];
  try {
    const { plan } = await loadPlan();
    const want = wanted(plan, today, Math.max(1, Math.min(28, settings.days)));
    // Workouts already on those days (to adopt one with the same name rather than add a twin).
    let onGarmin: coach.Scheduled[] | null = null;
    const garminDay = async (date: string) => {
      if (!onGarmin) {
        const r = await coach.getScheduled(today, addDays(today, settings.days));
        if (!r.ok) throw new Error(r.message);
        onGarmin = r.data;
      }
      return onGarmin.filter((s) => s.date === date);
    };
    for (const [date, { w, hash }] of want) {
      const have = state.days[date];
      if (have && have.hash === hash && !force) continue;
      if (have) {
        const r = await coach.update(have.workoutId, w);
        if (r.ok) {
          state.days[date] = { ...have, hash, name: w.name };
          done.push(`updated ${date}`);
          continue;
        }
        // Deleted on Garmin meanwhile: send it again below.
        delete state.days[date];
      }
      const twin = (await garminDay(date)).find((s) => s.name.trim().toLowerCase() === w.name.trim().toLowerCase());
      if (twin) {
        const r = await coach.update(twin.workoutId, w);
        if (!r.ok) throw new Error(r.message);
        state.days[date] = { workoutId: twin.workoutId, scheduleId: twin.scheduleId, hash, name: w.name };
        done.push(`updated ${date}`);
        continue;
      }
      const r = await coach.create(w, date);
      if (!r.ok) throw new Error(r.message);
      state.days[date] = { workoutId: r.data.workoutId, scheduleId: r.data.scheduleId ?? 0, hash, name: w.name };
      done.push(`added ${date}`);
    }
    // Days the plan no longer has a session for (moved, made a rest day, run already): take ours off.
    for (const [date, s] of Object.entries(state.days)) {
      // A day you've already run keeps its workout (it's your record of the session).
      if (want.has(date) || want.ran.has(date)) continue;
      if (s.scheduleId) await coach.unschedule(s.scheduleId);
      await coach.removeWorkout(s.workoutId);
      delete state.days[date];
      done.push(`removed ${date}`);
    }
    state.lastError = null;
    state.lastResult = done.length ? `${done.length} change${done.length === 1 ? "" : "s"}: ${done.join(", ")}` : "Up to date";
  } catch (e) {
    state.lastError = String((e as Error)?.message ?? e).replace(/^offline: /, "");
  }
  state.lastRun = new Date().toISOString();
  await kvSet(AUTOSYNC_STATE, state);
  return state;
}

/** Turning it off: takes the workouts it put on Garmin off again (if asked) and stops. */
export async function stopAutoSync(removeFromWatch: boolean) {
  await setAutoSync({ ...(await getAutoSync()), on: false });
  const state = await getAutoSyncState();
  if (removeFromWatch)
    for (const [date, s] of Object.entries(state.days)) {
      if (s.scheduleId) await coach.unschedule(s.scheduleId);
      await coach.removeWorkout(s.workoutId);
      delete state.days[date];
    }
  await kvSet(AUTOSYNC_STATE, { ...state, lastResult: removeFromWatch ? "Switched off; synced workouts removed" : "Switched off" });
}
