import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { BUNDLED_PLAN, WEEK_KEYS } from "./plan";
import { buildPlan, LEVELS, pacesFor, recommend, type BuildOptions, type History } from "./planBuilder";

const H: History = { recent4: 40, recent12: 55, peak12: 80, runsPerWeek: 4.5, longest8: 25, weeksRun12: 12, vdot: 55 };
const TODAY = "2026-11-03";
const O: BuildOptions = { raceName: "Test Marathon", raceDate: "2027-04-25", dist: "marathon", target: "2:50", weeks: 16, level: "advanced", days: 6, longDay: "sun", keepRaces: false };

describe("plan builder", () => {
  it("writes every day of the weeks up to the race, and keeps the rest of the old plan", () => {
    const { plan, weeks } = buildPlan(BUNDLED_PLAN, O, H, TODAY);
    expect(weeks).toHaveLength(16);
    const built = plan.weeks.filter((w) => w.start >= weeks[0].monday && w.start <= "2027-04-19");
    expect(built).toHaveLength(16);
    for (const w of built) for (const k of WEEK_KEYS) expect(w.sessions[k]).toBeTruthy();
    expect(plan.weeks.some((w) => w.start > "2027-04-25")).toBe(true);
    expect(plan.weeks.some((w) => w.end < weeks[0].monday)).toBe(true);
    expect(plan.races.find((r) => r.date === "2027-04-25")?.name).toBe("Test Marathon");
    expect(plan.previous?.title).toBe(BUNDLED_PLAN.title);
  });

  it("runs on the chosen number of days, with the long run on its day", () => {
    for (const days of [3, 4, 5, 6, 7]) {
      const { plan, weeks } = buildPlan(BUNDLED_PLAN, { ...O, days, longDay: "sat" }, H, TODAY);
      const w = weeks[5];
      const f = forecastWeek(plan, w.monday);
      expect(f.days.filter((d) => (d.km ?? 0) > 0)).toHaveLength(days);
      expect(f.days[5].kind).toBe("long");
    }
  });

  it("builds gradually, with easier weeks and a taper", () => {
    const { weeks } = buildPlan(BUNDLED_PLAN, O, H, TODAY);
    const L = LEVELS.advanced;
    for (let i = 1; i < weeks.length - 3; i++) if (!weeks[i].cut && !weeks[i - 1].cut) expect(weeks[i].km).toBeLessThanOrEqual(Math.ceil(weeks[i - 1].km * (1 + L.growth)) + 6);
    expect(weeks.some((w) => w.cut)).toBe(true);
    const peak = Math.max(...weeks.map((w) => w.km));
    expect(weeks[weeks.length - 1].km).toBeLessThan(peak * 0.6);
    expect(Math.max(...weeks.map((w) => w.long))).toBeLessThanOrEqual(L.longCap.marathon);
  });

  it("asks more of higher levels", () => {
    const peak = (level: BuildOptions["level"]) => Math.max(...buildPlan(BUNDLED_PLAN, { ...O, level }, H, TODAY).weeks.map((w) => w.km));
    expect(peak("beginner")).toBeLessThan(peak("intermediate"));
    expect(peak("intermediate")).toBeLessThan(peak("elite"));
  });

  it("suggests something sensible from your training", () => {
    const r = recommend(H, "marathon", 25);
    expect(r.days).toBeGreaterThanOrEqual(4);
    expect(r.weeks).toBeLessThanOrEqual(25);
    expect(["intermediate", "advanced"]).toContain(r.level);
    expect(recommend({ ...H, recent4: 5, recent12: 8, runsPerWeek: 1, weeksRun12: 5, vdot: null }, "half", 12).level).toBe("beginner");
  });

  it("gives Daniels-like paces", () => {
    const p = pacesFor(55);
    expect(p.mp).toBeGreaterThan(245);
    expect(p.mp).toBeLessThan(262);
    expect(p.threshold).toBeLessThan(p.hmp + 2);
    expect(p.easy[0]).toBeGreaterThan(p.mp + 40);
  });
});
