import { addDays } from "../../core/time";
import { forecastWeek, type DayKind } from "./forecast";
import { mondayOf, type Plan } from "./plan";
import type { Run } from "./strava";

/**
 * The four colours runs are drawn in everywhere: easy, long, speed (any
 * session with work at a pace) and race. CSS: .rt-easy / .rt-long / .rt-speed /
 * .rt-race / .rt-rest, from the --run-* colours in the theme.
 */
export type RunType = "easy" | "long" | "speed" | "race" | "rest";

export const RUN_TYPE_LABEL: Record<RunType, string> = { easy: "Easy", long: "Long", speed: "Speed", race: "Race", rest: "Rest" };

export function typeOfDay(kind: DayKind): RunType {
  return kind === "key" ? "speed" : kind === "long" ? "long" : kind === "race" ? "race" : kind === "rest" ? "rest" : "easy";
}

/** A run's type: from the plan's day when there is one, else guessed from the run itself. */
export function typeOfRun(r: Run, planned?: DayKind | null): RunType {
  const k = r.distance / 1000;
  if (r.workout_type === 1) return "race";
  if (planned === "race" && k >= 4.5) return "race";
  if (/\brace\b|marathon|parkrun|time trial|\btt\b|\bxc\b|cross country/i.test(r.name) && !/\bpace\b/i.test(r.name)) return "race";
  if (planned === "key") return "speed";
  if (planned === "long" && k >= 14) return "long";
  if (/interval|tempo|threshold|reps?\b|×|\d\s*x\s*\d|fartlek|track|session|hills?\b|progress|workout|\bmp\b|\bhmp\b/i.test(r.name)) return "speed";
  if (k >= 18 || (planned == null && k >= 16 && new Date(r.date + "T12:00").getDay() === 0)) return "long";
  return "easy";
}

export function RunTypeDot({ type, label }: { type: RunType; label?: boolean }) {
  return (
    <span className={`rt-pill rt-${type}`} title={RUN_TYPE_LABEL[type]}>
      {label ? RUN_TYPE_LABEL[type] : null}
    </span>
  );
}

/** What the plan had on each day between two dates (plan weeks only). */
export function plannedKinds(plan: Plan, from: string, to: string, overrides?: Map<string, string>): Map<string, DayKind> {
  const out = new Map<string, DayKind>();
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
    const fw = forecastWeek(plan, m, [], overrides);
    if (fw.week) for (const d of fw.days) out.set(d.date, d.kind);
  }
  return out;
}
