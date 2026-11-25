import { describe, expect, it } from "vitest";
import { aerobicTrend, paceAtHr, refHr, sessionChange, sessionKind, type SessionPoint } from "./progression";
import { raceHistory } from "./stats";
import { BUNDLED_PLAN } from "./plan";
import type { Run } from "./strava";

const run = (date: string, km: number, pace: number, hr: number, extra: Partial<Run> = {}): Run =>
  ({ id: date + km, date, start_local: date, name: "Running", sport: "Run", distance: km * 1000, moving_time: km * pace, elapsed_time: km * pace, elevation: km * 5, avg_hr: hr, max_hr: hr + 15, workout_type: null, polyline: null, gear_id: null, ...extra }) as Run;

describe("progression markers", () => {
  it("easy pace at a fixed heart rate: 140 at a max of 199", () => {
    expect(refHr(199)).toBe(140);
    // 6:00/km at 140 bpm is 6:00 at the reference; 6:00 at 130 bpm is quicker at 140.
    expect(paceAtHr(run("2026-11-01", 10, 360, 140), 140)).toBeCloseTo(360, 5);
    expect(paceAtHr(run("2026-11-01", 10, 360, 130), 140)).toBeCloseTo(360 * 130 / 140, 5);
    expect(paceAtHr(run("2026-11-01", 10, 300, 170), 140)).toBeNull(); // a session, not an easy run
    expect(paceAtHr(run("2026-11-01", 10, 360, 140, { elevation: 300 }), 140)).toBeNull(); // hilly
  });

  it("month by month, getting quicker", () => {
    const runs = [run("2026-06-03", 10, 400, 140), run("2026-06-10", 10, 396, 140), run("2026-11-03", 10, 330, 140), run("2026-11-10", 10, 334, 140), run("2026-08-03", 10, 360, 140)];
    const t = aerobicTrend(runs, 199, "2026-11-25");
    expect(t.points.map((p) => p.month)).toEqual(["2026-06", "2026-11"]); // one run in August: left out
    expect(t.points[1].pace).toBeLessThan(t.points[0].pace);
  });

  it("session kinds", () => {
    expect(sessionKind("15 km with 3 km warm-up, Threshold: 3 × 3 km at 3:48–3:52")).toBe("Threshold");
    expect(sessionKind("11 km with 3 km warm-up, VO2 max: 5 × 1 km at 3:29–3:33")).toBe("VO2 max");
    expect(sessionKind("13 km with 3 km warm-up, 10K pace: 6 × 1 km at 3:28")).toBe("10k pace");
    expect(sessionKind("9 km easy")).toBeNull();
  });

  it("session change: pace and heart rate, first to latest", () => {
    const p = (date: string, pace: number, hr: number): SessionPoint => ({ date, runId: date, kind: "Threshold", label: "", pace, target: [228, 232], hr, onTarget: true });
    const c = sessionChange([p("2026-11-18", 230, 181), p("2026-09-10", 237, 183)], "Threshold")!;
    expect(c.pace).toBe(-7);
    expect(c.hr).toBe(-2);
  });

  it("counts a marathon run at race effort as a race, even named 'Lausanne Running'", () => {
    const plan = { ...BUNDLED_PLAN, history: undefined };
    const lausanne = run("2026-10-25", 42.32, 254.2, 176, { name: "Lausanne Running" });
    const longRun = run("2026-10-04", 42.2, 300, 178, { name: "W10 Sun Long Run - 42 km" });
    const easy = run("2026-10-11", 42.2, 380, 140, { name: "Saint-Genis-Pouilly Running" });
    const rows = raceHistory([lausanne, longRun, easy], plan as never, 199);
    expect(rows.map((r) => r.date)).toEqual(["2026-10-25"]);
    expect(raceHistory([lausanne], plan as never)).toEqual([]); // no max heart rate: not by effort
  });
});
