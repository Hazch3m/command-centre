import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { checkRun, fmtTarget, fmtVal, verdictLabel } from "./pace";
import { BUNDLED_PLAN, type Plan } from "./plan";
import { hrRange, hrZones, widen } from "./targets";
import type { Run } from "./strava";

const run = (km: number, secs: number, hr: number | null): Run => ({
  id: "r", date: "2027-01-12", start_local: "2027-01-12T08:00", name: "Run", sport: "Run", distance: km * 1000, moving_time: secs, elapsed_time: secs, elevation: 0, avg_hr: hr, max_hr: null, workout_type: null, polyline: null, gear_id: null,
});
const zones = hrZones(BUNDLED_PLAN.paces, 199, 50);
const withPrefs = (prefs: Plan["prefs"]): Plan => ({ ...BUNDLED_PLAN, prefs, hrZones: zones });
const easyDay = (p: Plan) => {
  for (const w of p.weeks.slice(10, 20)) {
    const d = forecastWeek(p, w.start).days.find((x) => x.kind === "easy" && x.km && !/recover|strides/i.test(x.text));
    if (d) return d;
  }
  throw new Error("no easy day");
};

describe("targets", () => {
  it("reads heart-rate zones from the plan, or works them out", () => {
    expect(zones.find((z) => /^Easy/.test(z.zone))!.range).toEqual([130, 148]);
    const own = hrZones([{ zone: "Threshold (T)", hr: "" }], 190, 50);
    expect(own[0].range[0]).toBeGreaterThan(165);
    expect(widen("5:00–5:40")).toBe("4:45–5:55");
    expect(hrRange("130–148 bpm")).toEqual([130, 148]);
  });
  it("shows easy runs as a wider range, by feel, or as a heart-rate zone", () => {
    expect(easyDay(withPrefs({ mode: "pace", easyTarget: "exact", easyChecks: true })).pace).toBe("5:00–5:40");
    expect(easyDay(withPrefs({ mode: "pace", easyTarget: "wide", easyChecks: true })).pace).toBe("4:45–5:55");
    expect(easyDay(withPrefs({ mode: "pace", easyTarget: "feel", easyChecks: true })).pace).toBe("easy, by feel");
    expect(easyDay(withPrefs({ mode: "hr", easyTarget: "exact", easyChecks: true })).pace).toBe("130–148 bpm");
  });
  it("doesn't judge easy runs when that's switched off", () => {
    const d = easyDay(withPrefs({ mode: "pace", easyTarget: "exact", easyChecks: false }));
    expect(checkRun(d, run(10, 10 * 240, 150), null)).toBe(null);
    const on = easyDay(withPrefs({ mode: "pace", easyTarget: "exact", easyChecks: true }));
    expect(checkRun(on, run(10, 10 * 240, 150), null)!.verdict).toBe("too-fast");
  });
  it("judges on heart rate in heart-rate mode", () => {
    const d = easyDay(withPrefs({ mode: "hr", easyTarget: "exact", easyChecks: true }));
    const hard = checkRun(d, run(10, 3000, 160), null)!;
    expect(hard.unit).toBe("bpm");
    expect(verdictLabel(hard)).toBe("Too hard");
    expect(fmtVal(hard, hard.actual)).toBe("160 bpm");
    expect(fmtTarget(hard)).toBe("130–148 bpm");
    expect(checkRun(d, run(10, 3000, 140), null)!.verdict).toBe("on-point");
    expect(checkRun(d, run(10, 3000, 120), null)!.verdict).toBe("on-point");
  });
});
