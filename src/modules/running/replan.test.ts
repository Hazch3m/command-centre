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

describe("Monday re-plan: race pace, fatigue flags, volume cap (spec v1.2 step 7)", () => {
  // (Imported lazily to keep the file's header as it was.)
  it("2 weeks before Valencia's specific block, a goal more than 4 s/km faster than the prediction is clipped", async () => {
    const { racePaceCheck, withRacePace } = await import("./replanChecks");
    const { pacesFor } = await import("./planBuilder");
    const pred = pacesFor(57 - 2.9).mp;
    expect(racePaceCheck(base, "2027-07-27", 57, 2.9)).toEqual([]); // 3 weeks before: not yet
    const [s] = racePaceCheck(base, "2027-08-03", 57, 2.9);
    expect(s.race).toBe("Valencia marathon");
    expect(s.blockStart).toBe("2027-08-16");
    expect(s.to).toBe(Math.round(pred - 4));
    // Confirmed: the specific block's marathon-pace work uses it (and the goal time is unchanged).
    const n = replan(withRacePace(base, s), [], { today: "2027-08-03", vdotNow: 57, weekKm: new Map(), history: H });
    const mpText = n.weeks.filter((w) => w.start >= "2027-08-16" && w.start < "2027-11-15").flatMap((w) => Object.values(w.sessions) as string[]).find((t) => /Marathon pace:/.test(t))!;
    const lo = /Marathon pace:[^\d]*\d+[^\d]*?(\d):(\d\d)/.exec(mpText) ?? /(\d):(\d\d)/.exec(mpText.split("Marathon pace:")[1])!;
    expect(+lo[1] * 60 + +lo[2]).toBeGreaterThanOrEqual(s.to - 3);
    expect(n.races.find((r) => r.name === "Valencia marathon")!.target).toBe(base.races.find((r) => r.name === "Valencia marathon")!.target);
    // Once set, it isn't suggested again.
    expect(racePaceCheck(withRacePace(base, s), "2027-08-03", 57, 2.9)).toEqual([]);
  });

  it("a goal within 4 s/km of the prediction isn't touched", async () => {
    const { racePaceCheck } = await import("./replanChecks");
    expect(racePaceCheck(base, "2027-08-03", 65, 2.9)).toEqual([]);
  });

  const run = (date: string, km: number, pace: number, hr: number, id = date + km) => ({ id, date, start_local: date, name: "Run", sport: "Run", distance: km * 1000, moving_time: km * pace, elapsed_time: km * pace, elevation: 20, avg_hr: hr, max_hr: hr + 10, workout_type: null, polyline: null, gear_id: null });

  it("fatigue flags: efficiency, resting HR and HRV", async () => {
    const { fatigueFlags } = await import("./replanChecks");
    const today = "2027-01-12";
    const runs = [];
    for (let d = 14; d < 42; d += 2) runs.push(run(addD(today, -d), 10, 300, 142)); // baseline
    for (let d = 0; d < 14; d += 2) runs.push(run(addD(today, -d), 10, 318, 142)); // 6% slower at the same HR
    const health = Array.from({ length: 35 }, (_, k) => ({ date: addD(today, -k), rhr: k < 5 ? (k < 3 ? 52 : 46) : 45, hrv_status: k < 7 && k % 2 === 0 ? "UNBALANCED" : k < 7 ? "LOW" : "BALANCED" }));
    const flags = fatigueFlags({ plan: base, today, runs, health });
    expect(flags.length).toBe(3);
    expect(flags[0]).toMatch(/less efficient/);
    expect(fatigueFlags({ plan: base, today, runs: runs.slice(0, 14), health: [] })).toEqual([]);
  });

  it("key-session reps above their heart rate at target pace, twice in 10 days", async () => {
    const { fatigueFlags } = await import("./replanChecks");
    const today = "2027-02-19";
    const details = new Map();
    const runs = [];
    const keys = Array.from({ length: 10 }, (_, k) => addD(today, -k))
      .map((d) => ({ d, text: (weekOf(base, addD(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7))).sessions as Record<string, string>)[["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(d + "T12:00:00Z").getUTCDay()]] ?? "" }))
      .filter((x) => /Threshold:|VO2 max:/.test(x.text) && /at \d:\d\d/.test(x.text));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const { d, text } of keys.slice(0, 2)) {
      const m = /at (\d):(\d\d)/.exec(text)!;
      const pace = +m[1] * 60 + +m[2] + 1;
      const r = run(d, 14, 280, 170, "k" + d);
      runs.push(r);
      const cap = /Threshold/.test(text) ? 188 : Math.round(199 * 0.97);
      details.set(r.id, { splits: [], bestEfforts: [], laps: [0, 1, 2, 3].map(() => ({ distance: 1000, moving_time: pace, speed: 1000 / pace, hr: cap + 6 })) });
    }
    expect(fatigueFlags({ plan: base, today, runs, details }).some((f) => /session reps/.test(f))).toBe(true);
  });

  it("a lighter next week and the next VO2 max session dropped; today and past days untouched", async () => {
    const { lighterNextWeek } = await import("./replanChecks");
    const today = "2027-01-12";
    const l = lighterNextWeek(base, today);
    expect(l.dropped).not.toBeNull();
    expect(l.dropped!.date > today).toBe(true);
    expect(l.week!.start).toBe("2027-01-18");
    expect(l.week!.to).toBeLessThan(l.week!.from);
    for (const w of base.weeks.filter((x) => x.end < today)) expect(weekOf(l.plan, w.start)).toEqual(w);
    expect(weekOf(l.plan, "2027-01-11").sessions.mon).toBe(weekOf(base, "2027-01-11").sessions.mon);
    expect(weekOf(l.plan, "2027-01-11").sessions.tue).toBe(weekOf(base, "2027-01-11").sessions.tue);
  });

  it("raising the cap: 6 weeks at 90% or more with no fatigue flags", async () => {
    const { capCheck } = await import("./replanChecks");
    const today = "2027-10-05";
    const km = new Map(Array.from({ length: 12 }, (_, k) => [addD("2027-10-04", -7 * (k + 1)), 110]));
    expect(capCheck(base, today, km, 0)).toEqual({ from: 120, to: 130 });
    expect(capCheck(base, today, km, 1)).toBeNull();
    km.set("2027-09-06", 100);
    expect(capCheck(base, today, km, 0)).toBeNull();
    const n = replan(base, [], { today, vdotNow: null, weekKm: km, history: H }, { tune: { ...base.built!.tune, peakKm: 130 } });
    expect(n.built!.tune!.peakKm).toBe(130);
  });
});

function addD(d: string, n: number) {
  return new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
}
