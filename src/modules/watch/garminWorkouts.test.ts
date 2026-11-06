import { describe, expect, it } from "vitest";
import { describeGarmin, duration, targetOf, toGarmin, WorkoutError } from "./garminWorkouts";
import { sessionToWorkout } from "./importWeek";
import { repeat, step } from "./steps";

describe("workouts in Garmin Connect's format", () => {
  it("reads durations and targets", () => {
    expect(duration("10:00").endConditionValue).toBe(600);
    expect(duration("90s").endConditionValue).toBe(90);
    expect(duration("800m")).toMatchObject({ endCondition: { conditionTypeKey: "distance" }, endConditionValue: 800 });
    expect(duration("5km").endConditionValue).toBe(5000);
    expect(duration("lap").endCondition.conditionTypeKey).toBe("lap.button");
    expect(() => duration("soon")).toThrow(WorkoutError);
    const p = targetOf("pace 3:20-3:30/km") as { targetValueOne: number; targetValueTwo: number };
    expect(p.targetValueOne).toBeCloseTo(1000 / 210, 3); // slower pace = lower speed first
    expect(p.targetValueTwo).toBeCloseTo(1000 / 200, 3);
    expect(targetOf("hr zone 2")).toMatchObject({ zoneNumber: 2 });
    expect(targetOf("hr 140-150")).toMatchObject({ targetValueOne: 140, targetValueTwo: 150 });
  });

  it("builds repeats with Garmin's numbering", () => {
    const g = toGarmin({ name: "5 × 1 km", description: "", sport: "running", steps: [step("warmup", "15:00", "hr zone 2"), repeat(5, [step("interval", "1km", "pace 3:20-3:25/km"), step("recovery", "2:00")]), step("cooldown", "10:00")] });
    const s = g.workoutSegments[0].workoutSteps as Record<string, unknown>[];
    expect(s.map((x) => x.stepOrder)).toEqual([1, 2, 5]);
    expect(s[1]).toMatchObject({ type: "RepeatGroupDTO", numberOfIterations: 5, childStepId: 1 });
    expect((s[1].workoutSteps as Record<string, unknown>[]).map((x) => [x.stepOrder, x.childStepId])).toEqual([[3, 1], [4, 1]]);
    expect(describeGarmin(g)).toMatch(/5 ×\n.*Interval: 1 km at 3:20–3:25\/km/);
  });

  it("names the step that's wrong", () => {
    expect(() => toGarmin({ name: "x", description: "", sport: "running", steps: [step("warmup", "10:00"), step("interval", "forever")] })).toThrow(/Step 2/);
  });

  it("turns a plan session into a workout Garmin accepts", () => {
    const w = sessionToWorkout("14 km with 5 × 1 km at 3:20–3:25, 2 min jog", { T: "3:46–3:50" })!;
    const g = toGarmin(w);
    expect(JSON.stringify(g)).toMatch(/pace\.zone/);
    expect(g.workoutSegments[0].workoutSteps.length).toBeGreaterThan(1);
  });
});
