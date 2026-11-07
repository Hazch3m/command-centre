import { describe, expect, it } from "vitest";
import { addDays } from "../../core/time";
import { dailyLoad, easyShare, formLevel, loadSeries, monotony, zoneMinutes, zoneOfHr } from "./runalyze";

const hr = { hrMax: 200, hrRest: 50 };
const run = (date: string, min: number, avg: number | null) => ({ date, moving_time: min * 60, avg_hr: avg });

describe("runalyze", () => {
  it("fitness builds slowly, fatigue quickly, and form goes negative after a hard block", () => {
    const runs = Array.from({ length: 28 }, (_, i) => run(addDays("2026-01-01", i), 60, 150));
    const s = loadSeries(dailyLoad(runs, hr), "2026-01-01", "2026-02-10");
    const block = s.find((p) => p.date === "2026-01-28")!;
    expect(block.atl).toBeGreaterThan(block.ctl);
    expect(block.tsb).toBeLessThan(0);
    // Two weeks off: fatigue drops away faster than fitness, so form turns positive.
    const after = s.at(-1)!;
    expect(after.tsb).toBeGreaterThan(0);
    expect(after.ctl).toBeGreaterThan(0);
    expect(formLevel(after)).toBe("fresh");
  });
  it("the same load every day is monotonous; easy and hard days aren't", () => {
    const same = dailyLoad(Array.from({ length: 7 }, (_, i) => run(addDays("2026-03-01", i), 50, 140)), hr);
    expect(monotony(same, "2026-03-07").monotony).toBeNull();
    const mixed = dailyLoad([run("2026-03-01", 30, 130), run("2026-03-03", 90, 160), run("2026-03-05", 40, 135), run("2026-03-07", 120, 150)], hr);
    const m = monotony(mixed, "2026-03-07");
    expect(m.monotony).toBeGreaterThan(0.5);
    expect(m.monotony).toBeLessThan(2);
    expect(m.strain).toBeGreaterThan(0);
  });
  it("puts runs in heart-rate zones and checks 80/20", () => {
    expect(zoneOfHr(120, hr)).toBe(1);
    expect(zoneOfHr(150, hr)).toBe(2);
    expect(zoneOfHr(180, hr)).toBe(4);
    expect(zoneOfHr(195, hr)).toBe(5);
    const z = zoneMinutes([run("2026-03-01", 80, 145), run("2026-03-02", 20, 182), run("2026-03-03", 30, null)], hr, "2026-03-01");
    expect(z.find((x) => x.zone === 2)!.minutes).toBe(80);
    expect(easyShare(z)).toBeCloseTo(0.8);
  });
});
