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

describe("changing one run's distance from a week on", () => {
  const from = BUNDLED_PLAN.weeks.find((w) => w.start >= "2026-12-07")!.start;
  const week = (p: typeof BUNDLED_PLAN) => forecastWeek(p, from);
  const base = applyAdjust({ ...BUNDLED_PLAN, adjust: { ...ADJUST_DEFAULTS, from } });
  const easyDay = week(base).days.findIndex((d) => d.kind === "easy" && (d.km ?? 0) >= 8);
  const key = (["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const)[easyDay];

  it("adds to that weekday's run and the week, or keeps the week's km", () => {
    const add = applyAdjust({ ...BUNDLED_PLAN, adjust: { ...ADJUST_DEFAULTS, from, dayExtra: { [key]: 2 } } });
    const bal = applyAdjust({ ...BUNDLED_PLAN, adjust: { ...ADJUST_DEFAULTS, from, dayExtra: { [key]: 2 }, dayBalance: true } });
    expect(week(add).days[easyDay].km).toBe((week(base).days[easyDay].km ?? 0) + 2);
    expect(Math.abs((week(add).plannedKm ?? 0) - (week(base).plannedKm ?? 0) - 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((week(bal).plannedKm ?? 0) - (week(base).plannedKm ?? 0))).toBeLessThanOrEqual(1);
  });

  it("longer long runs never pass the cap, and can go on top of the week", () => {
    const cap = 30;
    const p = applyAdjust({ ...BUNDLED_PLAN, adjust: { ...ADJUST_DEFAULTS, from, longExtra: 6, longMax: cap, longBalance: false } });
    for (const w of p.weeks.filter((x) => x.start >= from)) for (const d of forecastWeek(p, w.start).days) if (d.kind === "long") expect(d.km ?? 0).toBeLessThanOrEqual(cap);
    const l0 = week(base).days.find((d) => d.kind === "long")?.km ?? 0;
    const l1 = week(p).days.find((d) => d.kind === "long")?.km ?? 0;
    if (l0 + 6 <= cap) expect((week(p).plannedKm ?? 0) - (week(base).plannedKm ?? 0)).toBeGreaterThanOrEqual(l1 - l0 - 1);
  });
});
