import { describe, expect, it } from "vitest";
import { rolling, summarize, windowAvg } from "./wellness";
import type { HealthDay } from "./data";

const day = (n: number) => new Date(Date.UTC(2026, 10, 21) - n * 864e5).toISOString().slice(0, 10);
const row = (n: number, rhr: number | null, hrv: number | null) => ({ date: day(n), rhr, hrv }) as unknown as HealthDay;

describe("wellness averages", () => {
  // 90 days: resting HR 50, a fitter month at 46 (days 40–69), and the last 5 days at 55. HRV missing on odd days.
  const rows = Array.from({ length: 90 }, (_, i) => row(i, i < 5 ? 55 : i >= 40 && i < 70 ? 46 : 50, i % 2 ? null : 70));

  it("7- and 30-day averages", () => {
    expect(windowAvg(rows, "rhr", day(0), 7)).toBeCloseTo((5 * 55 + 2 * 50) / 7, 5);
    expect(windowAvg(rows, "rhr", day(0), 30)).toBeCloseTo((5 * 55 + 25 * 50) / 30, 5);
    expect(windowAvg(rows, "hrv", day(0), 30)).toBe(70); // 15 values: enough
  });

  it("the lowest 30-day average on record, and the most recent if tied", () => {
    const s = summarize(rows, "rhr", day(0));
    expect(s.lowest_30_day_average).toEqual({ value: 46, period_end: day(40) });
    expect(s.highest_30_day_average!.value).toBeGreaterThan(50);
  });

  it("needs enough days in a window", () => {
    const sparse = [row(0, 50, null), row(3, 50, null)];
    expect(windowAvg(sparse, "rhr", day(0), 30)).toBeNull();
    expect(rolling(sparse, "rhr", 30, day(0))).toEqual([]);
  });
});
