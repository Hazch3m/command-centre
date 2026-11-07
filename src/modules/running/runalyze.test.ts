import { describe, expect, it } from "vitest";
import { addDays } from "../../core/time";
import { dailyLoad, easyShare, formLevel, loadSeries, monotony, zoneMinutes } from "./runalyze";
import { parseGarminZones, resolveZones, zoneOf, zoneRanges } from "./hrZones";

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
  it("puts runs in heart-rate zones (by km where it can) and checks 80/20", () => {
    const z = resolveZones({ method: "max", hrMax: 200 }, null, { hrMax: 190, hrRest: 50 });
    expect(z.floors).toEqual([100, 120, 140, 160, 180]);
    expect(zoneOf(90, z)).toBe(1);
    expect(zoneOf(130, z)).toBe(2);
    expect(zoneOf(175, z)).toBe(4);
    expect(zoneOf(195, z)).toBe(5);
    expect(zoneRanges(z)).toEqual(["< 120", "120–139", "140–159", "160–179", "180+"]);
    const runs = [
      { id: "a", date: "2026-03-01", moving_time: 80 * 60, avg_hr: 130 },
      { id: "b", date: "2026-03-02", moving_time: 20 * 60, avg_hr: 170 },
      { id: "c", date: "2026-03-03", moving_time: 30 * 60, avg_hr: null },
    ];
    const mins = zoneMinutes(runs, z, "2026-03-01");
    expect(mins.find((x) => x.zone === 2)!.minutes).toBe(80);
    expect(easyShare(mins)).toBeCloseTo(0.8);
    // Splits win over the average: a run of 4 easy km and 1 hard one.
    const split = (hr: number) => ({ distance: 1000, moving_time: 300, speed: 3.3, gap: null, hr, elev: null });
    const d = new Map([["b", { splits: [split(130), split(130), split(130), split(130), split(185)] }]]);
    const m2 = zoneMinutes([runs[1]], z, "2026-03-01", d);
    expect(m2.find((x) => x.zone === 2)!.minutes).toBe(20);
    expect(m2.find((x) => x.zone === 5)!.minutes).toBe(5);
  });
  it("uses Garmin's own zones when it has them", () => {
    const g = parseGarminZones([
      { sport: "DEFAULT", trainingMethod: "HR_MAX_BASED", zone1Floor: 98, zone2Floor: 118, zone3Floor: 137, zone4Floor: 157, zone5Floor: 176, maxHeartRateUsed: 196 },
      { sport: "RUNNING", trainingMethod: "HR_RESERVE_BASED", zone1Floor: 120, zone2Floor: 134, zone3Floor: 148, zone4Floor: 163, zone5Floor: 177, maxHeartRateUsed: 192, restingHeartRateUsed: 48 },
    ]);
    expect(g?.floors).toEqual([120, 134, 148, 163, 177]);
    const z = resolveZones(null, g, { hrMax: 190, hrRest: 50 });
    expect(z.method).toBe("garmin");
    expect(z.source).toMatch(/Garmin.*reserve/);
    // Your own choice wins; reserve uses Garmin's max and resting.
    const r = resolveZones({ method: "reserve" }, g, { hrMax: 190, hrRest: 50 });
    expect(r.floors[1]).toBe(Math.round(48 + 0.6 * (192 - 48)));
    expect(parseGarminZones({ nope: 1 })).toBeNull();
  });
});
