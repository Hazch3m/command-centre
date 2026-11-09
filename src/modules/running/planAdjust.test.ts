import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { BUNDLED_PLAN } from "./plan";
import { ADJUST_DEFAULTS, applyAdjust, rampFactors } from "./planAdjust";

describe("building up sooner", () => {
  const from = BUNDLED_PLAN.weeks.find((w) => w.start >= "2026-12-07")!.start;
  const a = { ...ADJUST_DEFAULTS, from, ramp: 3 };
  const km = (p: typeof BUNDLED_PLAN, monday: string) => forecastWeek(p, monday).plannedKm ?? 0;

  it("lifts the weeks ahead towards later mileage, never above the plan's peak, and leaves the taper alone", () => {
    const f = rampFactors(BUNDLED_PLAN, a);
    expect([...f.values()].some((x) => x > 1.02)).toBe(true);
    expect([...f.values()].every((x) => x >= 1 && x <= 1.3)).toBe(true);
    const after = applyAdjust({ ...BUNDLED_PLAN, adjust: a });
    const peak = Math.max(...BUNDLED_PLAN.weeks.map((w) => km(BUNDLED_PLAN, w.start)));
    expect(km(after, from)).toBeGreaterThanOrEqual(km(BUNDLED_PLAN, from));
    expect(Math.max(...after.weeks.map((w) => km(after, w.start)))).toBeLessThanOrEqual(peak * 1.05);
    for (const w of BUNDLED_PLAN.weeks.filter((x) => /taper/i.test(x.phase))) expect(f.get(w.start) ?? 1).toBe(1);
    // Weeks before it are as they were.
    const before = BUNDLED_PLAN.weeks.find((w) => w.start < from && w.start >= "2026-11-23");
    if (before) expect(km(after, before.start)).toBe(km(BUNDLED_PLAN, before.start));
  });
});
