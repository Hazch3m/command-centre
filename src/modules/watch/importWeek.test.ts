import { describe, expect, it } from "vitest";
import { defaultWeekStart, parseWeek, sessionToWorkout } from "./importWeek";
import { toToolSteps } from "./steps";

const zones = { MP: "4:00–4:05", HMP: "3:43–3:48", T: "3:40–3:48" };

describe("importing a week", () => {
  it("picks next week, or this week on a Monday", () => {
    expect(defaultWeekStart("2026-11-03")).toBe("2026-11-09");
    expect(defaultWeekStart("2026-11-09")).toBe("2026-11-09");
  });

  it("turns each day's line into a workout and skips rest days", () => {
    const d = parseWeek(
      "Week 2\nMon: Rest\nTue 17 Nov: 4 × 6 min T at 3:46–3:50, 1 min jog\nWednesday – 10 km easy + strength A\nSat: 7 km easy + 6 × 20 s strides\nSun: 28 km, last 6 at 4:05",
      "2026-11-16",
      zones,
    );
    expect(d.map((x) => x.date)).toEqual(["2026-11-17", "2026-11-18", "2026-11-21", "2026-11-22"]);
    expect(d[0].name).toBe("Threshold 4×6 min @ 3:46–3:50");
    expect(toToolSteps(d[0].steps)).toEqual([
      { kind: "warmup", duration: "15:00", target: "hr zone 2", notes: "Easy, build to steady" },
      { kind: "repeat", times: 4, steps: [
        { kind: "interval", duration: "6:00", target: "pace 3:46-3:50/km", notes: "3:46–3:50/km" },
        { kind: "recovery", duration: "1:00", target: "open", notes: "Easy jog" },
      ] },
      { kind: "cooldown", duration: "10:00", target: "hr zone 2", notes: "Easy" },
    ]);
    expect(d[1].steps[0]).toMatchObject({ duration: "10km", target: "hr zone 2" });
    expect(d[1].description).toMatch(/Strength A/);
    expect(d[2].steps).toHaveLength(2);
    expect(toToolSteps(d[3].steps)).toEqual([
      { kind: "interval", duration: "22km", target: "hr zone 2", notes: "Easy" },
      { kind: "interval", duration: "6km", target: "pace 4:05/km", notes: "4:05/km: smooth, not a race" },
    ]);
  });

  it("uses the plan's zones for MP and HMP", () => {
    const [mp] = parseWeek("Sun: 26 km, 14 at MP", "2026-11-16", zones);
    expect(toToolSteps(mp.steps)[1]).toMatchObject({ duration: "14km", target: "pace 4:00-4:05/km" });
  });

  it("flags lines it can't read", () => {
    const [p] = parseWeek("Sat: Parkrun with friends", "2026-11-16");
    expect(p.warning).toBeTruthy();
    expect(toToolSteps(p.steps)).toEqual([{ kind: "other", duration: "lap", target: "open", notes: "Parkrun with friends" }]);
  });
});

describe("sets and steps", () => {
  it("reads a fartlek in two sets as two repeats with easy between", () => {
    const w = sessionToWorkout("12 km with 2 km warm-up, fartlek: 4 × 1 min fartlek at 3:38–3:42, 1 min jog; then 4 × 2 min fartlek at 3:55–3:59, 90 s jog; 2 km cool-down")!;
    const kinds = w.steps.map((x) => (x.kind === "repeat" ? `rep${x.times}` : x.kind));
    expect(kinds).toEqual(["warmup", "rep4", "recovery", "rep4", "cooldown"]);
    expect(w.name).toBe("Fartlek 4×1 min + 4×2 min");
    expect(JSON.stringify(w.steps[3])).toContain("3:55");
    expect(JSON.stringify(w.steps[3])).toContain("90s");
  });
  it("reads a progression in steps", () => {
    const w = sessionToWorkout("15 km progression run: 5 km easy, 4 km at 4:40–4:46, 4 km at 4:25–4:31, 2 km at 4:10–4:16")!;
    expect(w.steps).toHaveLength(4);
    expect(w.name).toBe("Progression 15 km: 4/4/2 km faster");
    expect(JSON.stringify(w.steps[3])).toContain("4:10");
  });
  it("still reads one set and a plain fast finish as before", () => {
    expect(sessionToWorkout("10 km with 3 km warm-up, VO2 max: 6 × 800 m at 3:28–3:32, 90 s jog, 2 km cool-down")!.name).toBe("VO2 max 6×800 m @ 3:28–3:32");
    expect(sessionToWorkout("14 km progression run, last 4 at 4:10–4:16")!.name).toMatch(/^Progression 14 km, last 4 km/);
  });
});

describe("floats and over-unders", () => {
  it("reads float recoveries with their pace", () => {
    const w = sessionToWorkout("11 km with 3 km warm-up, 8 × 2 min fartlek at 3:50–3:54, 1 min float at 4:25–4:31, 2 km cool-down")!;
    const reps = w.steps[1] as { kind: string; times: number; steps: { kind: string; duration: string; target: string }[] };
    expect(reps.kind).toBe("repeat");
    expect(reps.times).toBe(8);
    expect(reps.steps[1].duration).toBe("1:00");
    expect(reps.steps[1].target).toContain("4:25");
    expect(reps.steps[0].target).toContain("3:50");
  });
  it("reads over-unders as blocks of under/over pairs with jogs between", () => {
    const w = sessionToWorkout("12 km with 3 km warm-up, Threshold over-unders: 3 × (4 × 2 min at 3:58–4:02 + 1 min at 3:38–3:42), 2 min jog, 2 km cool-down")!;
    const kinds = w.steps.map((x) => (x.kind === "repeat" ? `rep${x.times}` : x.kind));
    expect(kinds).toEqual(["warmup", "rep4", "recovery", "rep4", "recovery", "rep4", "cooldown"]);
    expect(w.name).toBe("Over-unders 3×(4×2 min/1 min)");
  });
});

describe("slow paces (10:00/km and slower)", () => {
  it("keeps both minute digits", async () => {
    const { sessionToWorkout } = await import("./importWeek");
    const w = sessionToWorkout("26 km long run, last 4 at 10:05–10:11")!;
    expect(JSON.stringify(w)).toMatch(/10:05/);
    expect(JSON.stringify(w)).not.toMatch(/"pace 0:/);
  });
});
