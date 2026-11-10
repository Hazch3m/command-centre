import { describe, expect, it } from "vitest";
import { segmentsOf } from "./EffortProfile";

describe("session parts", () => {
  it("splits a session into warm-up, reps and cool-down that add up to its distance", () => {
    for (const t of ["12 km with 5 × 1 km at 3:30, 2 min jog", "14 km with 3 × 3 km at 3:50-3:55, 2 min jog", "12 km with 8 × 10 s hill sprints"]) {
      const s = segmentsOf(t);
      if (!s.length) continue;
      const sum = s.reduce((a, x) => a + x.km, 0);
      expect(Math.abs(sum - Number(/^(\d+)/.exec(t)![1]))).toBeLessThan(0.6);
      expect(s.some((x) => x.kind === "work")).toBe(true);
    }
    expect(segmentsOf("12 km with 5 × 1 km at 3:30, 2 min jog").length).toBeGreaterThan(1);
  });
  it("leaves plain easy runs alone", () => {
    expect(segmentsOf("10 km easy")).toEqual([]);
  });
});
