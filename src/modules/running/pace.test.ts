import { describe, expect, it } from "vitest";
import type { ForecastDay } from "./forecast";
import { checkRun, paceRange, workKm } from "./pace";
import type { Run, RunDetail } from "./strava";

const day = (text: string, kind: ForecastDay["kind"], pace: string, km = 10): ForecastDay => ({ date: "2026-11-17", dow: "Tue", text, kind, km, pace, strength: null, race: null, actualKm: 0, runs: [] });
const run = (km: number, secs: number) => ({ id: "r", date: "2026-11-17", distance: km * 1000, moving_time: secs }) as Run;
const split = (p: number) => ({ distance: 1000, moving_time: p, speed: 1000 / p, gap: null, hr: 170, elev: 0 });

describe("pace on point", () => {
  it("reads targets and work", () => {
    expect(paceRange("3:46–3:50")).toEqual([226, 230]);
    expect(paceRange("by feel")).toBeNull();
    expect(workKm("28 km, last 6 at 4:05", 245)?.km).toBe(6);
    expect(workKm("32 km, 16 at 3:58–4:02", 240)?.km).toBe(16);
    expect(workKm("5 × 1 km at 3:22, 2 min jog", 202)).toEqual({ km: 5, rep: 1 });
    expect(workKm("25 min T at 3:43–3:46", 225)?.km).toBeCloseTo(6.67, 2);
  });
  it("treats easy pace as a ceiling", () => {
    expect(checkRun(day("10–14 km easy", "easy", "5:00–5:40"), run(12, 12 * 330), null)?.verdict).toBe("on-point");
    expect(checkRun(day("10–14 km easy", "easy", "5:00–5:40"), run(12, 12 * 350), null)?.verdict).toBe("on-point");
    const fast = checkRun(day("10–14 km easy", "easy", "5:00–5:40"), run(12, 12 * 290), null)!;
    expect(fast.verdict).toBe("too-fast");
    expect(fast.off).toBe(-7);
  });
  it("judges sessions on the work: laps when the watch has them, else the fastest km", () => {
    const laps = [{ distance: 2000, moving_time: 660 }, ...[1, 2, 3, 4, 5].map(() => ({ distance: 1000, moving_time: 201 })), { distance: 2000, moving_time: 650 }].map((l) => ({ ...l, speed: l.distance / l.moving_time, hr: null }));
    const withLaps: RunDetail = { splits: [300, 205, 200, 300].map(split), bestEfforts: [], laps };
    const c = checkRun(day("5 × 1 km at 3:22, 2 min jog", "key", "3:22"), run(12, 3000), withLaps)!;
    expect(c.measured).toBe("5 work laps");
    expect(c.verdict).toBe("on-point");
    const kms: RunDetail = { splits: [300, 230, 229, 231, 300, 228, 232, 300, 240, 300].map(split), bestEfforts: [] };
    const t = checkRun(day("4 × 6 min T at 3:46–3:50, 1 min jog", "key", "3:46–3:50"), run(10, 2700), kms)!;
    expect(t.measured).toBe("fastest 6 km");
    expect(t.verdict).toBe("on-point");
  });
  it("can't judge 400 m reps from km splits", () => {
    expect(checkRun(day("8 × 400 m at 3:12–3:15, 200 m jog", "key", "3:12–3:15"), run(10, 2700), { splits: [300, 280].map(split), bestEfforts: [] })).toBeNull();
  });
});

describe("pace text", () => {
  it("never shows 60 seconds", async () => {
    const { fmtPace } = await import("./pace");
    expect(fmtPace(239.6)).toBe("4:00");
    expect(fmtPace(225)).toBe("3:45");
  });
});
