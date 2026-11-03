import { describe, expect, it } from "vitest";
import { defaultWeekStart, parseWeek } from "./importWeek";
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
