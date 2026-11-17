import { describe, expect, it } from "vitest";
import { BUNDLED_PLAN, weeksAlreadyDone, type PlanWeek } from "./plan";
import { buildPlan, type BuildOptions, type History } from "./planBuilder";
import { mergeImported, csvToWeeks } from "./planCsv";

// Whatever changes the plan (a rebuild, an import, going back to the previous plan), the weeks you've
// already done stay as they were and the new weeks carry on numbering after them.
const wk = (start: string, week: string, sun = "15 km long run"): PlanWeek => {
  const d = new Date(start + "T12:00Z");
  const end = new Date(d.getTime() + 6 * 864e5).toISOString().slice(0, 10);
  return { week, start, end, phase: "Base", km: "50", kmMin: 50, kmMax: 50, notes: "", sessions: { mon: "5 km recovery", tue: "10 km easy", wed: "Rest", thu: "10 km easy", fri: "Rest", sat: "5 km easy", sun } };
};

describe("keeping your progress when the plan changes", () => {
  it("counts the weeks of this block already done", () => {
    expect(weeksAlreadyDone([wk("2026-11-02", "R2"), wk("2026-11-09", "1"), wk("2026-11-16", "2")], "2026-11-23")).toBe(2);
    // A plan rebuilt before numbering carried on: "1" then "1" is still two weeks.
    expect(weeksAlreadyDone([wk("2026-11-02", "R2"), wk("2026-11-09", "1"), wk("2026-11-16", "1")], "2026-11-23")).toBe(2);
    // The end of an older block isn't counted.
    expect(weeksAlreadyDone([wk("2026-10-19", "12"), wk("2026-10-26", "13"), wk("2026-11-02", "1"), wk("2026-11-09", "2")], "2026-11-16")).toBe(2);
    // A gap before the new start: nothing carries on.
    expect(weeksAlreadyDone([wk("2026-11-02", "1"), wk("2026-11-09", "2")], "2026-11-23")).toBe(0);
  });

  const h: History = { recent4: 50, recent12: 45, peak12: 64, runsPerWeek: 6, longest8: 20, weeksRun12: 12, vdot: 57 };
  const o: BuildOptions = { raceName: "Valencia", raceDate: "2027-12-05", dist: "marathon", target: "2:39", weeks: 60, level: "elite", days: 6, longDay: "sun", keepRaces: false };
  const old = { ...BUNDLED_PLAN, races: [], weeks: [wk("2026-11-02", "R2"), wk("2026-11-09", "1", "19 km long run"), wk("2026-11-16", "2", "20 km long run")] };

  it("a rebuild mid-week keeps this week and the last, and carries on from week 3", () => {
    const r = buildPlan(old, o, h, "2026-11-17");
    const byStart = new Map(r.plan.weeks.map((w) => [w.start, w]));
    expect(byStart.get("2026-11-09")).toEqual(old.weeks[1]);
    expect(byStart.get("2026-11-16")).toEqual(old.weeks[2]);
    expect(byStart.get("2026-11-23")!.week).toBe("3");
    expect(byStart.get("2026-11-30")!.week).toBe("4");
    // Rebuilding again later carries on too.
    const again = buildPlan(r.plan, o, h, "2026-11-24");
    expect(again.plan.weeks.find((w) => w.start === "2026-11-23")).toEqual(byStart.get("2026-11-23"));
    expect(again.plan.weeks.find((w) => w.start === "2026-11-30")!.week).toBe("4");
  });

  it("an import never replaces past weeks or this week, and carries on numbering", () => {
    const csv = ["week_start,mon,tue,wed,thu,fri,sat,sun", "2026-11-09,Rest,8 km easy,8 km easy,8 km easy,Rest,8 km easy,16 km long run", "2026-11-16,Rest,9 km easy,9 km easy,9 km easy,Rest,9 km easy,18 km long run", "2026-11-23,Rest,10 km easy,10 km easy,10 km easy,Rest,10 km easy,20 km long run", "2026-11-30,Rest,11 km easy,11 km easy,11 km easy,Rest,11 km easy,22 km long run"].join("\n");
    const merged = mergeImported(old, csvToWeeks(csv), null, "plan.csv", "2026-11-17");
    expect(merged.weeks.find((w) => w.start === "2026-11-09")).toEqual(old.weeks[1]);
    expect(merged.weeks.find((w) => w.start === "2026-11-16")).toEqual(old.weeks[2]);
    expect(merged.weeks.find((w) => w.start === "2026-11-23")).toMatchObject({ week: "3" });
    expect(merged.weeks.find((w) => w.start === "2026-11-23")!.sessions.sun).toBe("20 km long run");
  });
});
