import { describe, expect, it } from "vitest";
import real from "./fixtures/real-splits.json";
import {
  estimateRun,
  garminOffset,
  judge,
  loadRatio,
  predictTime,
  projectionAt,
  slopePerWeek,
  trimp,
  vdot,
  weeklySeries,
  type Split,
  type Vo2Config,
} from "./vo2";

const cfg: Vo2Config = { hrMax: 199, hrRest: 50, projection: { start: { date: "2026-11-09", vo2: null }, milestones: [] } };
const runs = real as unknown as Record<string, { splits: Split[]; expect: [number, number] | null }>;

describe("VO2 max from real Strava laps", () => {
  it("matches the independent reference for every run", () => {
    for (const [id, r] of Object.entries(runs)) {
      const e = estimateRun(r.splits, cfg);
      if (r.expect == null) expect(e, id).toBeNull();
      else {
        expect(e!.n, id).toBe(r.expect[1]);
        expect(e!.vo2, id).toBeCloseTo(r.expect[0], 2);
      }
    }
  });
  it("gives sensible values: Lausanne ~51.9 (first 30 km), 1 Oct intervals ~54.4", () => {
    expect(estimateRun(runs["20727686060"].splits, cfg)!.vo2).toBeCloseTo(51.9, 1);
    expect(estimateRun(runs["20727686060"].splits, cfg)!.n).toBe(27);
    expect(estimateRun(runs["20402567292"].splits, cfg)!.vo2).toBeCloseTo(54.4, 1);
  });
  it("ignores alternating-pace workouts where heart rate lags", () => {
    expect(estimateRun(runs["20202445293"].splits, cfg)).toBeNull();
  });
});

describe("VDOT and predictions", () => {
  it("matches Daniels' tables", () => {
    expect(vdot(42195, 2 * 3600 + 59 * 60 + 45)).toBeCloseTo(53.6, 1);
    expect(vdot(42195, 170 * 60)).toBeCloseTo(57.3, 1); // sub-2:50
    expect(vdot(42195, 165 * 60)).toBeCloseTo(59.3, 1); // sub-2:45
  });
  it("inverts back to the race time", () => {
    expect(Math.round(predictTime(42195, vdot(42195, 10200)))).toBe(10200);
    // Daniels: VDOT 55 → 18:22, 60 → 17:03, so 57.3 → ~17:44
    expect(predictTime(5000, 57.3) / 60).toBeGreaterThan(17.5);
    expect(predictTime(5000, 57.3) / 60).toBeLessThan(18.0);
    expect(predictTime(5000, 60) / 60).toBeCloseTo(17.05, 1);
  });
});

describe("projection and status", () => {
  const start = { date: "2026-11-09", vo2: 53.5 };
  const ms = [
    { date: "2027-05-30", vo2: 57.3 },
    { date: "2027-12-05", vo2: 59.3 },
  ];
  it("interpolates between milestones", () => {
    expect(projectionAt("2026-11-01", start, ms)).toBe(53.5);
    expect(projectionAt("2027-05-30", start, ms)).toBeCloseTo(57.3, 5);
    expect(projectionAt("2027-08-31", start, ms)).toBeCloseTo(57.3 + (93 / 189) * 2, 2);
    expect(projectionAt("2028-01-01", start, ms)).toBe(59.3);
  });
  it("judges a week against the projection", () => {
    expect(judge(55, 54)).toBe("ahead");
    expect(judge(53.2, 54)).toBe("on-track");
    expect(judge(52.5, 54)).toBe("behind");
    expect(judge(null, 54)).toBe("no-data");
  });
  it("builds weekly values, smoothing and slope", () => {
    const est = [
      { id: "a", date: "2026-10-06", name: "", vo2: 52, n: 4 },
      { id: "b", date: "2026-10-13", name: "", vo2: 53, n: 4 },
      { id: "c", date: "2026-10-20", name: "", vo2: 54, n: 4 },
      { id: "d", date: "2026-10-22", name: "", vo2: 56, n: 4 },
      { id: "e", date: "2026-10-27", name: "", vo2: 55, n: 4 },
    ];
    const w = weeklySeries(est, "2026-10-05", "2026-11-02");
    expect(w.map((x) => x.value)).toEqual([52, 53, 55, 55, null]);
    expect(w[2].smooth).toBe(53.5);
    // x = 0,1,2,3; y = 52,53,55,55 → slope 1.1
    expect(slopePerWeek(w)).toBeCloseTo(1.1, 5);
    expect(slopePerWeek(w.slice(0, 3))).toBeNull(); // too few weeks to call a trend
  });
  it("calibrates to Garmin readings", () => {
    const est = [{ id: "a", date: "2026-10-20", name: "", vo2: 54, n: 4 }];
    expect(garminOffset([{ date: "2026-10-25", vo2: 57 }], est)).toBe(3);
    expect(garminOffset([{ date: "2026-12-25", vo2: 57 }], est)).toBeNull();
  });
});

describe("training load", () => {
  it("weights hard minutes more", () => {
    expect(trimp(3600, 140, cfg)).toBeLessThan(trimp(3600, 175, cfg));
    expect(trimp(3600, null, cfg)).toBeCloseTo(54, 0);
  });
  it("computes the acute:chronic ratio", () => {
    const daily = Array.from({ length: 28 }, (_, i) => ({ date: `2026-10-${String(i + 2).padStart(2, "0")}`, load: i >= 21 ? 20 : 10 }));
    const r = loadRatio(daily, "2026-10-29");
    expect(r.acute).toBe(140);
    expect(r.chronic).toBe((210 + 140) / 4);
    expect(r.ratio).toBeCloseTo(1.6, 5);
    expect(r.status).toBe("very-high");
  });
});

import { targetTime } from "./fitness";
describe("race targets", () => {
  it("reads the slower end of a target range", () => {
    expect(targetTime("17:15–17:30", 5000)).toBe(1050);
    expect(targetTime("2:48–2:52", 42195)).toBe(10320);
    expect(targetTime("1:17:30–1:18:30", 21097.5)).toBe(4710);
    expect(targetTime("Sub-2:45", 42195)).toBe(9900);
  });
});

import { quantile } from "./vo2";
describe("quantile", () => {
  it("interpolates", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.75)).toBe(4);
    expect(quantile([1, 2], 0.75)).toBe(1.75);
    expect(quantile([], 0.5)).toBeNull();
  });
});

import { marathonShape, shapeFactor } from "./fitness";
describe("marathon shape", () => {
  const mk = (date: string, km: number) => ({ id: date + km, date, start_local: date, name: "", sport: "Run", distance: km * 1000, moving_time: km * 300, elapsed_time: km * 300, elevation: 0, avg_hr: null, max_hr: null, workout_type: null, polyline: null, gear_id: null });
  it("is 100 % when weekly km and long runs meet the targets", () => {
    const runs = [];
    for (let i = 1; i <= 26; i++) {
      const d = new Date(Date.UTC(2026, 9, 26 - 7 * i));
      const day = d.toISOString().slice(0, 10);
      runs.push(mk(day, 30), mk(day, 30), mk(day, 32)); // ~92 km/week with a 32 km long run
    }
    const s = marathonShape(runs, "2026-10-29", 55);
    expect(s.targetKm).toBeCloseTo(94.75, 1);
    expect(s.total).toBeGreaterThan(0.95);
    expect(shapeFactor(42195, s.total)).toBeCloseTo(1 + (Math.max(0, 1 - s.total)) * 0.12, 5);
  });
  it("slows the marathon prediction when the volume isn't there", () => {
    const s = marathonShape([mk("2026-10-20", 10)], "2026-10-29", 55);
    expect(s.total).toBeLessThan(0.1);
    expect(shapeFactor(42195, s.total)).toBeGreaterThan(1.1);
    expect(shapeFactor(5000, 0.5)).toBe(1);
  });
});

import { enduranceModel } from "./fitness";
describe("personal endurance curve", () => {
  it("fits k to the best race in each band and anchors on the best 10k-equivalent", () => {
    const races = [
      { date: "2026-03-22", name: "10k", distance: 10000, seconds: 2241 },
      { date: "2026-09-24", name: "5.5k", distance: 5500, seconds: 1189 },
      { date: "2026-10-25", name: "Marathon", distance: 42195, seconds: 10785 },
      { date: "2024-09-07", name: "Old half", distance: 21097.5, seconds: 7218 }, // too old for the fit
    ];
    const m = enduranceModel(races, "2026-10-29", 2272)!;
    expect(m.fitted).toBe(true);
    expect(m.k).toBeGreaterThan(1.06);
    expect(m.k).toBeLessThan(1.1);
    expect(m.anchor).toBe("10k");
    expect(Math.round(m.predict(10000))).toBe(2241);
    expect(m.predict(42195) / 60).toBeGreaterThan(175);
    expect(m.predict(42195) / 60).toBeLessThan(182);
  });
  it("falls back to k = 1.07 with one race, and to current form when that's better", () => {
    const m = enduranceModel([{ date: "2026-10-01", name: "10k", distance: 10000, seconds: 2400 }], "2026-10-29", 2300)!;
    expect(m.fitted).toBe(false);
    expect(m.k).toBe(1.07);
    expect(m.anchor).toBe("current form");
  });
});
