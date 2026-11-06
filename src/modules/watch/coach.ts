import { backend } from "@backend";
import { kvGet, kvSet } from "../../core/db";
import { describeGarmin, toGarmin, WorkoutError } from "./garminWorkouts";
import type { Workout } from "./steps";

/**
 * Putting workouts on your Garmin calendar, straight through Garmin Connect
 * with the app's Garmin sign-in (no separate server). Scheduled workouts reach
 * the watch on its next sync. With cloud sync on, this goes through your sync
 * service, so it works from the phone too.
 */

// ---- connection state (the status light) ----

export type LinkState = "unknown" | "connecting" | "ok" | "login" | "down";
export interface Link {
  state: LinkState;
  message: string | null;
}
let link: Link = { state: "unknown", message: null };
const listeners = new Set<() => void>();
function setLink(l: Link) {
  link = l;
  listeners.forEach((f) => f());
}
export const getLink = () => link;
export const subscribeLink = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export const LOGIN_MESSAGE = "Garmin sign-in expired: connect Garmin again in Settings → Connections.";
const LOGIN_RE = /sign-?in expired|isn't connected|\b401\b|\b403\b|unauthori[sz]ed|connect garmin again/i;

/** Whether Garmin is connected (the light shows "not connected" otherwise). */
export async function status(): Promise<{ tokensFound: boolean }> {
  const st = await backend.garminStatus().catch(() => ({ connected: false }));
  if (!st.connected) setLink({ state: "down", message: "Connect Garmin in Settings → Connections." });
  else if (link.state === "unknown" || link.state === "down") setLink({ state: "ok", message: null });
  return { tokensFound: st.connected };
}

export type Outcome<T = unknown> =
  | { ok: true; data: T; text: string }
  | { ok: false; kind: "login" | "invalid" | "error"; message: string };

const fail = (e: unknown): Outcome<never> => {
  const message = String((e as Error)?.message ?? e).replace(/^offline: /, "");
  if (e instanceof WorkoutError) return { ok: false, kind: "invalid", message: `Invalid workout: ${message}` };
  if (LOGIN_RE.test(message)) {
    setLink({ state: "login", message: LOGIN_MESSAGE });
    return { ok: false, kind: "login", message: LOGIN_MESSAGE };
  }
  setLink({ state: "down", message });
  return { ok: false, kind: "error", message };
};
const answer = (r: { status: number; body: unknown }, what: string) => {
  if (r.status === 401 || r.status === 403) throw new Error(`${r.status}: connect Garmin again`);
  if (r.status >= 400) {
    const msg = typeof r.body === "string" ? r.body : (r.body as { message?: string; errorMessage?: string } | null)?.message ?? (r.body as { errorMessage?: string } | null)?.errorMessage;
    throw new Error(`Garmin couldn't ${what} (HTTP ${r.status})${msg ? `: ${String(msg).slice(0, 200)}` : ""}`);
  }
  setLink({ state: "ok", message: null });
  return r.body;
};

// ---- the workout service ----

export interface Scheduled {
  date: string;
  name: string;
  workoutId: number;
  scheduleId: number;
}

/** Workouts on your Garmin calendar between two dates. */
export async function getScheduled(from: string, to: string): Promise<Outcome<Scheduled[]>> {
  try {
    const out: Scheduled[] = [];
    let y = +from.slice(0, 4);
    let m = +from.slice(5, 7);
    const ey = +to.slice(0, 4);
    const em = +to.slice(5, 7);
    for (let n = 0; n < 14 && (y < ey || (y === ey && m <= em)); n++) {
      const body = answer(await backend.garminRequest(`/calendar-service/year/${y}/month/${m - 1}`), "read your calendar") as { calendarItems?: Record<string, unknown>[] } | null;
      for (const it of body?.calendarItems ?? [])
        if (it.itemType === "workout" && typeof it.date === "string" && it.date >= from && it.date <= to)
          out.push({ date: it.date, name: String(it.title ?? "Workout"), workoutId: Number(it.workoutId), scheduleId: Number(it.id) });
      if (++m > 12) (m = 1), y++;
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return { ok: true, data: out, text: "" };
  } catch (e) {
    return fail(e);
  }
}

/** Checks the workout converts cleanly, and describes it the way Garmin will see it. */
export async function preview(w: Workout): Promise<Outcome<string>> {
  try {
    const text = describeGarmin(toGarmin(w));
    return { ok: true, data: text, text };
  } catch (e) {
    return fail(e);
  }
}

/** Saves the workout in Garmin Connect, and puts it on the calendar if a date is given. */
export async function create(w: Workout, date?: string): Promise<Outcome<{ workoutId: number; scheduleId?: number }>> {
  try {
    const body = answer(await backend.garminWrite("POST", "/workout-service/workout", toGarmin(w)), "save the workout") as { workoutId?: number };
    if (!body?.workoutId) throw new Error("Garmin didn't return the new workout");
    let scheduleId: number | undefined;
    if (date) scheduleId = (await schedule(body.workoutId, date)).scheduleId;
    return { ok: true, data: { workoutId: body.workoutId, scheduleId }, text: "" };
  } catch (e) {
    return fail(e);
  }
}

/** Puts a saved workout on a day of your Garmin calendar. */
export async function schedule(workoutId: number, date: string): Promise<{ scheduleId: number }> {
  const body = answer(await backend.garminWrite("POST", `/workout-service/schedule/${workoutId}`, { date }), "put the workout on your calendar") as { workoutScheduleId?: number; id?: number };
  return { scheduleId: Number(body?.workoutScheduleId ?? body?.id ?? 0) };
}
export async function scheduleOutcome(workoutId: number, date: string): Promise<Outcome<{ scheduleId: number }>> {
  try {
    return { ok: true, data: await schedule(workoutId, date), text: "" };
  } catch (e) {
    return fail(e);
  }
}

export async function update(workoutId: number, w: Workout): Promise<Outcome<{ workoutId: number }>> {
  try {
    answer(await backend.garminWrite("PUT", `/workout-service/workout/${workoutId}`, toGarmin(w, workoutId)), "update the workout");
    return { ok: true, data: { workoutId }, text: "" };
  } catch (e) {
    return fail(e);
  }
}

export async function unschedule(scheduleId: number): Promise<Outcome<null>> {
  try {
    answer(await backend.garminWrite("DELETE", `/workout-service/schedule/${scheduleId}`), "take the workout off your calendar");
    return { ok: true, data: null, text: "" };
  } catch (e) {
    return fail(e);
  }
}

export async function removeWorkout(workoutId: number): Promise<Outcome<null>> {
  try {
    answer(await backend.garminWrite("DELETE", `/workout-service/workout/${workoutId}`), "delete the workout");
    return { ok: true, data: null, text: "" };
  } catch (e) {
    return fail(e);
  }
}

/** A workout made elsewhere (Garmin Connect, another app), in words. */
export async function getWorkout(workoutId: number): Promise<Outcome<string>> {
  try {
    const body = answer(await backend.garminRequest(`/workout-service/workout/${workoutId}`), "read the workout") as Parameters<typeof describeGarmin>[0];
    const text = describeGarmin(body ?? {});
    return { ok: true, data: text, text };
  } catch (e) {
    return fail(e);
  }
}

/** Which step is wrong, for the builder to highlight. */
export async function findBadStep(w: Workout): Promise<{ id: string; message: string } | null> {
  for (const it of w.steps) {
    const items = it.kind === "repeat" ? (it.times >= 1 && it.steps.length ? it.steps : [it]) : [it];
    for (const s of items) {
      try {
        toGarmin({ ...w, name: w.name || "x", steps: s.kind === "repeat" ? [s] : [s] });
      } catch (e) {
        return { id: s.id, message: String((e as Error).message).replace(/^Step \d+(?: › \d+)?:\s*/, "") };
      }
    }
  }
  return null;
}

// ---- what this app put on Garmin (so a workout can be edited later) ----

export const getSaved = () => kvGet<Record<string, Workout>>("watch.saved", {});
export async function remember(workoutId: number, w: Workout) {
  const all = await getSaved();
  all[String(workoutId)] = w;
  await kvSet("watch.saved", all);
}
