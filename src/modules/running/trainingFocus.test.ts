import { describe, expect, it } from "vitest";
import { loadFocus, plannedFocus, runFocus } from "./trainingFocus";

const cuts = { low: 270, anaerobic: 220 };
const zones = { floors: [100, 120, 140, 160, 180] };

describe("training focus", () => {
  it("an easy run is all low aerobic", () => {
    const m = plannedFocus("10 km easy", cuts)!;
    expect(m.low).toBeCloseTo(1);
  });
  it("threshold reps are mostly high aerobic, VO2 reps at 5K pace bring anaerobic", () => {
    const t = plannedFocus("12 km with 3 km warm-up, Threshold: 4 × 2 km at 3:58–4:02, 90 s jog, 2 km cool-down", cuts)!;
    expect(t.high).toBeGreaterThan(0.3);
    expect(t.anaerobic).toBe(0);
    const v = plannedFocus("10 km with 3 km warm-up, VO2 max: 6 × 800 m at 3:28–3:32, 90 s jog, 2 km cool-down", cuts)!;
    expect(v.anaerobic).toBeGreaterThan(0.15);
    expect(v.low).toBeGreaterThan(0.4);
  });
  it("a run splits by each km: heart rate for aerobic, 5K pace or faster for anaerobic", () => {
    const split = (hr: number, secs = 300) => ({ distance: 1000, moving_time: secs, speed: 1000 / secs, gap: null, hr, elev: null });
    const m = runFocus({ moving_time: 1410, distance: 5000, avg_hr: 150 }, { splits: [split(130), split(130), split(150), split(185), split(186, 210)] }, zones, cuts)!;
    expect(m.low).toBeCloseTo(900 / 1410);
    expect(m.high).toBeCloseTo(300 / 1410);
    expect(m.anaerobic).toBeCloseTo(210 / 1410);
    // An easy run in zones 2–3 (under ~150 here) is all low aerobic.
    const e = runFocus({ moving_time: 1500, distance: 5000, avg_hr: 145 }, { splits: [split(135), split(142), split(148), split(149), split(146)] }, zones, cuts)!;
    expect(e.low).toBeCloseTo(1);
    // A hard tempo in zone 5 is still high aerobic, not anaerobic.
    const t = runFocus({ moving_time: 1200, distance: 5000, avg_hr: 186 }, { splits: [split(186, 240)] }, zones, cuts)!;
    expect(t.high).toBeCloseTo(1);
  });
  it("four weeks of only easy running is short of high aerobic or anaerobic", () => {
    const runs = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, date: `2026-03-${String(i + 1).padStart(2, "0")}`, moving_time: 3000, distance: 10000, avg_hr: 130 }));
    const f = loadFocus(runs, new Map(), zones, cuts, "2026-03-14");
    expect(f.share.low).toBeCloseTo(1);
    expect(["high", "anaerobic"]).toContain(f.short);
    expect(f.over).toBe("low");
  });
});
