import { describe, expect, it } from "vitest";
import { harryPlan } from "./valenciaRegression.test";
import { replan, replanDiff, replanReasons } from "./replan";
import type { Plan } from "./plan";

// Monday re-plan (spec step 7) and provisional paces (step 6), on Harry's plan.
const H = { recent4: 40, recent12: 43, peak12: 61, runsPerWeek: 5, longest8: 21, weeksRun12: 12, vdot: 57 };
const base = harryPlan().plan;
const weekOf = (p: Plan, d: string) => p.weeks.find((w) => w.start === d)!;
const ranAsPlanned = (p: Plan, upTo: string) => new Map(p.weeks.filter((w) => w.start < upTo).map((w) => [w.start, w.kmMin ?? 0]));

describe("provisional paces and projected VDOT (step 6)", () => {
  it("every week has its projected VDOT, rising to race day", () => {
    const ws = base.weeks.filter((w) => w.start >= "2026-11-16");
    expect(ws.every((w) => typeof w.vdot === "number")).toBe(true);
    expect(ws[ws.length - 1].vdot!).toBeGreaterThan(ws[0].vdot!);
  });
  it("paces are provisional after the next race (the 5k on 19 Dec)", () => {
    expect(weekOf(base, "2026-12-14").provisional).toBeFalsy();
    expect(weekOf(base, "2026-12-21").provisional).toBe(true);
  });
  it("projected VDOT at each race", () => {
    const t = base.vdotTargets!;
    expect(t.map((x) => x.name)).toContain("Edinburgh marathon");
    expect(t.find((x) => x.name === "Summer 10k")!.approx).toBe(true);
  });
  it("marathon pace in a long run outside a specific block is marked provisional", () => {
    const w = base.weeks.find((x) => x.start < "2027-03-29" && / at MP /.test(x.sessions.sun ?? ""))!;
    expect(w.notes).toMatch(/provisional/);
  });
});

describe("Monday re-plan (step 7)", () => {
  const today = "2027-01-12"; // a Tuesday: changes start on Monday 18 Jan
  const vProj = weekOf(base, "2027-01-11").vdot!;

  it("suggests nothing when training and fitness are on plan", () => {
    expect(replanReasons(base, { today, vdotNow: vProj, weekKm: ranAsPlanned(base, "2027-01-11") })).toEqual([]);
  });

  it("a re-plan with nothing changed gives the same weeks, and keeps the weeks done", () => {
    const p = replan(base, [], { today, vdotNow: vProj, weekKm: ranAsPlanned(base, "2027-01-11"), history: H });
    for (const w of base.weeks) {
      const n = weekOf(p, w.start);
      expect(n.week, w.start).toBe(w.week);
      expect(n.kmMin, w.start).toBe(w.kmMin);
      expect(n.sessions, w.start).toEqual(w.sessions);
    }
  });

  it("fixing an approximate race date suggests a re-plan", () => {
    const p = { ...base, races: base.races.map((r) => (r.name === "Summer 10k" ? { ...r, approx: false } : r)) };
    const rs = replanReasons(p, { today, vdotNow: vProj, weekKm: ranAsPlanned(base, "2027-01-11") });
    expect(rs.map((r) => r.kind)).toEqual(["race"]);
    expect(rs[0].text).toMatch(/Summer 10k's date is now fixed/);
  });

  it("a moved race re-plans around its new date", () => {
    const p = { ...base, races: base.races.map((r) => (r.name === "Summer 10k" ? { ...r, approx: false, date: "2027-07-25" } : r)) };
    const rs = replanReasons(p, { today, vdotNow: vProj, weekKm: ranAsPlanned(base, "2027-01-11") });
    expect(rs[0].text).toMatch(/moved from 18 Jul to 25 Jul/);
    const n = replan(p, rs, { today, vdotNow: vProj, weekKm: ranAsPlanned(base, "2027-01-11"), history: H });
    expect(weekOf(n, "2027-07-19").sessions.sun).toMatch(/Summer 10k/);
    expect(weekOf(n, "2027-07-12").sessions.sun ?? "").not.toMatch(/Summer 10k/);
  });

  it("fitness a VDOT away from the projection moves the paces from the next week", () => {
    const rs = replanReasons(base, { today, vdotNow: vProj + 1.5, weekKm: ranAsPlanned(base, "2027-01-11") });
    expect(rs.map((r) => r.kind)).toEqual(["fitness"]);
    const n = replan(base, rs, { today, vdotNow: vProj + 1.5, weekKm: ranAsPlanned(base, "2027-01-11"), history: H });
    expect(weekOf(n, "2027-01-11").sessions).toEqual(weekOf(base, "2027-01-11").sessions);
    expect(weekOf(n, "2027-01-18").vdot!).toBeCloseTo(weekOf(base, "2027-01-18").vdot! + 1.5, 0);
    expect(weekOf(n, "2027-01-18").kmMin).toBe(weekOf(base, "2027-01-18").kmMin);
  });

  it("a short week builds back from what you ran", () => {
    const km = ranAsPlanned(base, "2027-01-11");
    km.set("2027-01-04", 30);
    const rs = replanReasons(base, { today, vdotNow: vProj, weekKm: km });
    expect(rs.map((r) => r.kind)).toEqual(["missed"]);
    const n = replan(base, rs, { today, vdotNow: vProj, weekKm: km, history: H });
    expect(weekOf(n, "2027-01-18").kmMin!).toBeLessThanOrEqual(Math.round(weekOf(base, "2027-01-18").kmMin! * 0.75));
    expect(weekOf(n, "2027-01-25").kmMin!).toBeLessThan(weekOf(base, "2027-01-25").kmMin!);
    const d = replanDiff(base, n, today);
    expect(d[0].start).toBe("2027-01-18");
    expect(d[0].to!).toBeLessThan(d[0].from!);
  });
});
