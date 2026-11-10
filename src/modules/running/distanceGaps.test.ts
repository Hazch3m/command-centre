import { describe, expect, it } from "vitest";
import { bestStretch, distanceGaps } from "./distanceGaps";
import type { Run, RunDetail } from "./strava";

const split = (sPerKm: number) => ({ distance: 1000, moving_time: sPerKm, speed: 1000 / sPerKm, gap: null, hr: null, elev: null });
const run = (id: string, date: string, km: number, sPerKm: number): Run => ({ id, date, name: id, distance: km * 1000, moving_time: km * sPerKm, elapsed_time: km * sPerKm, start_local: date + "T08:00:00" }) as unknown as Run;

describe("distance gaps", () => {
  it("finds the fastest stretch of a length in a run", () => {
    expect(bestStretch([split(300), split(240), split(240), split(300)], 2000)).toBe(240);
  });
  it("says mileage when the long runs aren't there, pace when the pace isn't", () => {
    const today = "2026-11-10";
    // Short, fast runs: lots of 5K-paced km, nothing long.
    const runs = [run("a", "2026-11-01", 8, 215), run("b", "2026-11-05", 8, 215), run("c", "2026-11-08", 8, 215)];
    const details = new Map<string, RunDetail>(runs.map((r) => [r.id, { splits: Array.from({ length: 8 }, () => split(215)), bestEfforts: [] }]));
    const g = distanceGaps(runs, details, 60, today);
    const by = Object.fromEntries(g.map((x) => [x.name, x]));
    expect(by["Marathon"].verdict === "mileage" || by["Marathon"].verdict === "both").toBe(true);
    expect(by["Half marathon"].longestKm).toBe(8);
    expect(by["5K"].bestPace).toBe(215);
  });
});
