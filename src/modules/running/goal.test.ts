import { describe, expect, it } from "vitest";
import { goalPath } from "./FitnessPlan";

describe("goal path", () => {
  const path = goalPath({ date: "2026-11-09", seconds: 10670 }, [
    { date: "2027-05-30", label: "Sub-2:50 · Edinburgh", seconds: 10200 },
    { date: "2027-12-05", label: "Sub-2:45 · Valencia", seconds: 9900 },
  ]);
  it("passes through the start and each goal", () => {
    expect(path("2026-11-01")).toBe(10670);
    expect(Math.round(path("2027-05-30"))).toBe(10200);
    expect(Math.round(path("2027-12-05"))).toBe(9900);
    expect(path("2028-01-01")).toBe(9900);
  });
  it("improves steadily in between (linear in speed)", () => {
    const mid = path("2027-02-18"); // halfway to Edinburgh
    expect(1 / mid).toBeCloseTo((1 / 10670 + 1 / 10200) / 2, 8);
  });
});
