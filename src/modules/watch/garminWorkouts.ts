import type { Item, Step, StepKind, Workout } from "./steps";

/**
 * Workouts in Garmin Connect's own format (what its workout service takes),
 * from the app's steps. Garmin sends scheduled workouts to the watch on its
 * next sync. Durations: "10:00", "90s", "5 min", "800m", "5km", "lap".
 * Targets: "open", "pace 4:50-5:05/km", "hr zone 2", "hr 140-150".
 */

const STEP_TYPE: Record<StepKind, [number, string]> = {
  warmup: [1, "warmup"],
  cooldown: [2, "cooldown"],
  interval: [3, "interval"],
  recovery: [4, "recovery"],
  rest: [5, "rest"],
  other: [7, "other"],
};
const SPORT = { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 };
const cond = (id: number, key: string) => ({ conditionTypeId: id, conditionTypeKey: key, displayOrder: id, displayable: true });
const target = (id: number, key: string) => ({ workoutTargetTypeId: id, workoutTargetTypeKey: key, displayOrder: id });

export class WorkoutError extends Error {}

/** "10:00" → time 600 s; "800m" → distance 800 m; "lap" → lap button. */
export function duration(d: string): { endCondition: ReturnType<typeof cond>; endConditionValue: number | null } {
  const s = d.trim().toLowerCase();
  if (!s || s === "lap" || s === "lap button") return { endCondition: cond(1, "lap.button"), endConditionValue: null };
  let m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) {
    const secs = m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
    if (secs <= 0) throw new WorkoutError(`"${d}" is no time at all`);
    return { endCondition: cond(2, "time"), endConditionValue: secs };
  }
  m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?)$/.exec(s);
  if (m) return { endCondition: cond(2, "time"), endConditionValue: Math.round(+m[1]) };
  m = /^(\d+(?:\.\d+)?)\s*(min|mins|minutes?)$/.exec(s);
  if (m) return { endCondition: cond(2, "time"), endConditionValue: Math.round(+m[1] * 60) };
  m = /^(\d+(?:\.\d+)?)\s*(m|km|mi)$/.exec(s);
  if (m) {
    const metres = m[2] === "km" ? +m[1] * 1000 : m[2] === "mi" ? +m[1] * 1609.34 : +m[1];
    if (metres <= 0) throw new WorkoutError(`"${d}" is no distance at all`);
    return { endCondition: cond(3, "distance"), endConditionValue: Math.round(metres) };
  }
  throw new WorkoutError(`"${d}" isn't a duration: use a time (10:00, 90s, 5 min), a distance (800m, 5km) or "lap"`);
}

const paceSecs = (t: string) => {
  const [a, b] = t.split(":").map(Number);
  return a * 60 + b;
};

/** "pace 4:50-5:05/km" → Garmin's pace zone in m/s (the slower pace is the lower value). */
export function targetOf(t: string): Record<string, unknown> {
  const s = t.trim();
  if (!s || /^open$/i.test(s)) return { targetType: target(1, "no.target") };
  let m = /^pace\s+(\d{1,2}:\d{2})\s*(?:-\s*(\d{1,2}:\d{2}))?\s*(?:\/\s*km)?$/i.exec(s);
  if (m) {
    const fast = paceSecs(m[1]);
    const slow = m[2] ? paceSecs(m[2]) : fast;
    const [quick, easy] = fast <= slow ? [fast, slow] : [slow, fast];
    // A single pace gets a little room either side, like Garmin's own editor.
    const lo = 1000 / (easy + (quick === easy ? 5 : 0));
    const hi = 1000 / (quick - (quick === easy ? 5 : 0));
    return { targetType: target(6, "pace.zone"), targetValueOne: +lo.toFixed(4), targetValueTwo: +hi.toFixed(4) };
  }
  m = /^hr\s+zone\s+([1-5])$/i.exec(s);
  if (m) return { targetType: target(4, "heart.rate.zone"), zoneNumber: +m[1] };
  m = /^hr\s+(\d{2,3})\s*-\s*(\d{2,3})(?:\s*bpm)?$/i.exec(s);
  if (m) return { targetType: target(4, "heart.rate.zone"), targetValueOne: Math.min(+m[1], +m[2]), targetValueTwo: Math.max(+m[1], +m[2]) };
  throw new WorkoutError(`"${t}" isn't a target: use open, pace 4:50-5:05/km, hr zone 2 or hr 140-150`);
}

/** The workout as Garmin Connect's workout service takes it. Throws WorkoutError naming the bad step. */
export function toGarmin(w: Workout, workoutId?: number) {
  if (!w.name.trim()) throw new WorkoutError("The workout needs a name.");
  if (!w.steps.length) throw new WorkoutError("The workout has no steps.");
  let order = 0;
  let group = 0;
  const stepJson = (s: Step, where: string, child: number | null) => {
    try {
      const [id, key] = STEP_TYPE[s.kind] ?? STEP_TYPE.other;
      return {
        type: "ExecutableStepDTO",
        stepOrder: ++order,
        stepType: { stepTypeId: id, stepTypeKey: key, displayOrder: id },
        childStepId: child,
        description: s.notes?.trim() || null,
        ...duration(s.duration),
        ...targetOf(s.target),
      };
    } catch (e) {
      throw new WorkoutError(`${where}: ${(e as Error).message}`);
    }
  };
  const items = (list: Item[]) =>
    list.map((it, i) => {
      if (it.kind !== "repeat") return stepJson(it, `Step ${i + 1}`, null);
      if (!Number.isInteger(it.times) || it.times < 1) throw new WorkoutError(`Step ${i + 1}: a repeat needs a whole number of times (1 or more)`);
      if (!it.steps.length) throw new WorkoutError(`Step ${i + 1}: this repeat has no steps`);
      const child = ++group;
      const own = ++order;
      return {
        type: "RepeatGroupDTO",
        stepOrder: own,
        stepType: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
        childStepId: child,
        numberOfIterations: it.times,
        smartRepeat: false,
        endCondition: cond(7, "iterations"),
        endConditionValue: it.times,
        workoutSteps: it.steps.map((s, j) => stepJson(s, `Step ${i + 1} › ${j + 1}`, child)),
      };
    });
  const steps = items(w.steps);
  return {
    ...(workoutId ? { workoutId } : {}),
    workoutName: w.name.trim().slice(0, 80),
    description: w.description.trim() || null,
    sportType: SPORT,
    workoutSegments: [{ segmentOrder: 1, sportType: SPORT, workoutSteps: steps }],
  };
}

const fmtPace = (mps: number) => {
  const s = Math.round(1000 / mps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtSecs = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);

/** Garmin's workout, in words (for the preview and for workouts made elsewhere). */
export function describeGarmin(g: { workoutName?: string; workoutSegments?: { workoutSteps?: unknown[] }[] }): string {
  const line = (raw: unknown, indent: string): string[] => {
    const s = raw as Record<string, unknown> & { stepType?: { stepTypeKey?: string }; endCondition?: { conditionTypeKey?: string }; targetType?: { workoutTargetTypeKey?: string } };
    if (s.type === "RepeatGroupDTO") return [`${indent}${s.numberOfIterations} ×`, ...((s.workoutSteps as unknown[]) ?? []).flatMap((x) => line(x, indent + "   "))];
    const v = Number(s.endConditionValue ?? 0);
    const dur = s.endCondition?.conditionTypeKey === "time" ? fmtSecs(v) : s.endCondition?.conditionTypeKey === "distance" ? (v >= 1000 ? `${+(v / 1000).toFixed(2)} km` : `${v} m`) : "until lap";
    const t = s.targetType?.workoutTargetTypeKey;
    const tgt =
      t === "pace.zone"
        ? ` at ${fmtPace(Number(s.targetValueTwo))}–${fmtPace(Number(s.targetValueOne))}/km`
        : t === "heart.rate.zone"
          ? s.zoneNumber
            ? ` in heart-rate zone ${s.zoneNumber}`
            : ` at ${s.targetValueOne}–${s.targetValueTwo} bpm`
          : "";
    const kind = s.stepType?.stepTypeKey ?? "step";
    return [`${indent}${kind.charAt(0).toUpperCase() + kind.slice(1)}: ${dur}${tgt}${s.description ? ` (${s.description})` : ""}`];
  };
  return [g.workoutName ?? "Workout", ...(g.workoutSegments ?? []).flatMap((seg) => (seg.workoutSteps ?? []).flatMap((x) => line(x, "  ")))].join("\n");
}
