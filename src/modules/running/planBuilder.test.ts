import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { sessionToWorkout } from "../watch/importWeek";
import { BUNDLED_PLAN, WEEK_KEYS } from "./plan";
import { buildPlan, doublesAdvice, LEVELS, pacesFor, recommend, type BuildOptions, type History } from "./planBuilder";

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
    const r = recommend(H, "marathon", 25, "2026-11-09");
    expect(r.days).toBeGreaterThanOrEqual(4);
    expect(r.weeks).toBeLessThanOrEqual(25);
    expect(["intermediate", "advanced"]).toContain(r.level);
    // Aiming for what a marathon needs pushes the suggestion up.
    const big = recommend(H, "marathon", 25, "2026-11-09", 100);
    expect(["advanced", "elite"]).toContain(big.level);
    expect(big.days).toBeGreaterThanOrEqual(r.days);
    expect(recommend({ ...H, recent4: 5, recent12: 8, runsPerWeek: 1, weeksRun12: 5, vdot: null }, "half", 12, "2026-11-09").level).toBe("beginner");
  });

  it("gives Daniels-like paces", () => {
    const p = pacesFor(55);
    expect(p.mp).toBeGreaterThan(245);
    expect(p.mp).toBeLessThan(262);
    expect(p.threshold).toBeLessThan(p.hmp + 2);
    expect(p.easy[0]).toBeGreaterThan(p.mp + 40);
  });
});

describe("plan builder: goals, speed work and tweaks", () => {
  const bp = buildPlan;
  const h = { recent4: 60, recent12: 58, peak12: 70, runsPerWeek: 5, longest8: 26, weeksRun12: 12, vdot: 53.6 };
  const base = { raceName: "Test Marathon", raceDate: "2027-10-24", dist: "marathon" as const, target: "", weeks: 20, level: "advanced" as const, days: 6, longDay: "sun" as const, keepRaces: false };
  // Only the weeks the builder made (your plan's earlier weeks are kept as they were).
  const all = (o: Parameters<typeof bp>[1]) => {
    const r = bp(BUNDLED_PLAN, o, h, "2026-11-06");
    const from = r.weeks[0].monday;
    return r.plan.weeks.filter((w) => w.start >= from && w.start <= "2027-10-24").flatMap((w) => Object.values(w.sessions) as string[]);
  };

  it("never puts in hill sprints unless asked, and varies the speed work", () => {
    const s = all(base);
    expect(s.some((x) => /hill sprints/.test(x))).toBe(false);
    for (const re of [/fartlek/, /progression run/, /× 2 km at|× 3 km at|× 1 km at/, /km at MP/]) expect(s.some((x) => re.test(x))).toBe(true);
    expect(all({ ...base, tune: { hillSprints: true } }).some((x) => /hill sprints/.test(x))).toBe(true);
  });

  it("adds doubles only when asked, as a short easy PM run counted in the week, never sent to the watch", () => {
    expect(all(base).some((x) => /PM:/.test(x))).toBe(false);
    const r = bp(BUNDLED_PLAN, { ...base, tune: { doubles: 2, peakKm: 115 } }, h, "2026-11-06");
    const ws = r.plan.weeks.filter((w) => w.start >= r.weeks[0].monday && w.start <= "2027-10-24");
    const build = ws.filter((w) => /build|specific/i.test(w.phase));
    expect(build.some((w) => Object.values(w.sessions).filter((x) => /· PM: \d/.test(x ?? "")).length === 2)).toBe(true);
    // Never in the taper or race week.
    expect(ws.slice(-2).some((w) => Object.values(w.sessions).some((x) => /PM:/.test(x ?? "")))).toBe(false);
    const d = build.flatMap((w) => Object.values(w.sessions) as string[]).find((x) => /PM:/.test(x))!;
    const wk = sessionToWorkout(d)!;
    expect(JSON.stringify(wk)).not.toMatch(/PM/);
    expect(doublesAdvice(70, 6, "advanced").suggest).toBe(0);
    expect(doublesAdvice(120, 6, "advanced").suggest).toBe(2);
    expect(doublesAdvice(120, 5, "advanced").suggest).toBe(0);
    expect(doublesAdvice(120, 7, "beginner").suggest).toBe(0);
  });

  it("sharpens for a B race in the two weeks before it, unless you turn it off", () => {
    const tune = { date: "2027-03-14", approx: false, when: "", name: "Spring 10k", target: "", role: "tune-up", priority: "B" as const, km: 10 };
    const o = { ...base, extraRaces: [tune] };
    const r = bp(BUNDLED_PLAN, o, h, "2026-11-06");
    const before = r.plan.weeks.filter((w) => w.start >= "2027-02-28" && w.start <= "2027-03-07").flatMap((w) => Object.values(w.sessions) as string[]);
    expect(before.some((x) => /^.*10K pace: /.test(x))).toBe(true);
    const off = bp(BUNDLED_PLAN, { ...o, tune: { sharpen: false } }, h, "2026-11-06");
    expect(off.plan.weeks.flatMap((w) => Object.values(w.sessions) as string[]).some((x) => /10K pace: /.test(x))).toBe(false);
  });

  it("only uses the kinds you pick", () => {
    const s = all({ ...base, tune: { kinds: ["fartlek", "racepace"] } });
    expect(s.some((x) => /fartlek/.test(x))).toBe(true);
    expect(s.some((x) => /progression run|hill reps|min T at/.test(x))).toBe(false);
  });

  it("ramps faster when you ask for it", () => {
    const slow = bp(BUNDLED_PLAN, { ...base, weeks: 30, tune: { growth: 0.03 } }, h, "2026-11-06").weeks;
    const fast = bp(BUNDLED_PLAN, { ...base, weeks: 30, tune: { growth: 0.1 } }, h, "2026-11-06").weeks;
    // Ten weeks in, the quicker ramp is well ahead.
    expect(fast[9].km).toBeGreaterThan(slow[9].km * 1.15);
  });

  it("builds blocks without a race", () => {
    const o = { ...base, goal: "base" as const, raceName: "Build base", weeks: 8, raceDate: "2027-01-03" };
    const r = bp(BUNDLED_PLAN, o, h, "2026-11-06");
    expect(r.plan.races.some((x) => x.name === "Build base")).toBe(false);
    expect(r.weeks).toHaveLength(8);
    const rec = bp(BUNDLED_PLAN, { ...o, goal: "recover" as const, weeks: 3, raceDate: "2026-11-29" }, h, "2026-11-06");
    expect(Math.max(...rec.weeks.map((w) => w.km))).toBeLessThan(55);
    const fast = bp(BUNDLED_PLAN, { ...o, goal: "faster" as const, dist: "10k" as const, weeks: 10, raceDate: "2027-01-17" }, h, "2026-11-06");
    expect(Object.values(fast.plan.weeks.find((w) => w.start === "2027-01-11")!.sessions).some((x) => /time trial/.test(x ?? ""))).toBe(true);
  });

  it("every new session goes to the watch as a structured workout", () => {
    for (const x of all(base)) {
      if (/^Rest$|race$|Marathon$/i.test(x)) continue;
      const w = sessionToWorkout(x);
      expect(w, x).not.toBeNull();
      if (/fartlek|× .* at|progression run|last \d+ at/.test(x)) expect(w!.steps.length, x).toBeGreaterThan(1);
    }
  });
});

describe("following the plan: changes and advice", () => {
  it("makes a week easier or a rest week, and recovery mode replaces runs", async () => {
    const { applyChanges } = await import("./planChanges");
    const w = BUNDLED_PLAN.weeks.find((x) => x.start >= "2026-12-07")!;
    const total = (p: typeof BUNDLED_PLAN) => forecastWeek(p, w.start).days.reduce((a, d) => a + (d.km ?? 0), 0);
    const easier = applyChanges({ ...BUNDLED_PLAN, changes: { weeks: { [w.start]: "easier" } } });
    expect(total(easier)).toBeLessThan(total(BUNDLED_PLAN) * 0.8);
    expect(Object.values(easier.weeks.find((x) => x.start === w.start)!.sessions).some((x) => /\bat\b/.test(x ?? ""))).toBe(false);
    const rest = applyChanges({ ...BUNDLED_PLAN, changes: { weeks: { [w.start]: "rest" } } });
    expect(total(rest)).toBe(0);
    const rec = applyChanges({ ...BUNDLED_PLAN, changes: { recovery: { from: w.start, weeks: 2, mode: "cross" } } });
    expect(Object.values(rec.weeks.find((x) => x.start === w.start)!.sessions).some((x) => /Cross-train/.test(x ?? ""))).toBe(true);
    const after = rec.weeks.find((x) => x.start > w.start && x.start >= "2026-12-21")!;
    expect(after).toEqual(BUNDLED_PLAN.weeks.find((x) => x.start === after.start));
  });
  it("steps a week up when you choose to: a second session, an extra day, doubles, double threshold", async () => {
    const { applyChanges } = await import("./planChanges");
    const w0 = BUNDLED_PLAN.weeks.find((x) => x.start >= "2026-12-07" && !/taper|race/i.test(x.phase))!;
    // A week with one session (Tuesday) and the long run, so there's room for a second.
    const P = { ...BUNDLED_PLAN, weeks: BUNDLED_PLAN.weeks.map((x) => (x.start === w0.start ? { ...x, sessions: { ...x.sessions, thu: "10 km easy" } } : x)) };
    const w = P.weeks.find((x) => x.start === w0.start)!;
    const sess = (p: typeof BUNDLED_PLAN) => Object.values(p.weeks.find((x) => x.start === w.start)!.sessions) as string[];
    const total = (p: typeof BUNDLED_PLAN) => forecastWeek(p, w.start).days.reduce((a, d) => a + (d.km ?? 0), 0);
    const count = (p: typeof BUNDLED_PLAN, re: RegExp) => sess(p).filter((x) => re.test(x ?? "")).length;
    const up = applyChanges({ ...P, changes: { progress: { from: w.start, extraSession: true } } });
    expect(count(up, /Threshold:/)).toBeGreaterThan(count(P, /Threshold:/));
    const day = applyChanges({ ...P, changes: { progress: { from: w.start, extraDay: true } } });
    if (count(P, /^Rest/) > 0) {
      expect(count(day, /^Rest/)).toBeLessThan(count(P, /^Rest/));
      expect(total(day)).toBeGreaterThan(total(P));
    }
    const dbl = applyChanges({ ...P, changes: { progress: { from: w.start, doubles: 2 } } });
    expect(count(dbl, /· PM: 6 km easy/)).toBeGreaterThanOrEqual(1);
    const dt = applyChanges({ ...P, changes: { progress: { from: w.start, doubleThreshold: true } } });
    expect(count(dt, /Threshold: .* · PM: .*Threshold:/)).toBe(1);
    // Weeks before it are untouched.
    const before = P.weeks.find((x) => x.start < w.start && x.start >= "2026-11-30");
    if (before) expect(up.weeks.find((x) => x.start === before.start)).toEqual(before);
  });
  it("moves pace targets, never clock times", async () => {
    const { shiftPaces } = await import("./planChanges");
    expect(shiftPaces("12 km with 3 × 3 km at 3:42–3:46, 2 min jog", 5)).toBe("12 km with 3 × 3 km at 3:47–3:51, 2 min jog");
    expect(shiftPaces("Race 1:18:30", 5)).toBe("Race 1:18:30");
  });
});

describe("plan builder: long runs and labels", () => {
  const h = { recent4: 70, recent12: 68, peak12: 80, runsPerWeek: 6, longest8: 30, weeksRun12: 12, vdot: 53.6 };
  const o = { raceName: "Test Marathon", raceDate: "2027-10-24", dist: "marathon" as const, target: "", weeks: 30, level: "elite" as const, days: 6, longDay: "sun" as const, keepRaces: false };
  it("reaches the longest long run only a few times, with shorter ones between", () => {
    const r = buildPlan(BUNDLED_PLAN, o, h, "2026-11-06");
    const longest = Math.max(...r.weeks.map((w) => w.long));
    expect(r.weeks.filter((w) => w.long >= longest - 1).length).toBeLessThanOrEqual(4);
    const spec = r.weeks.filter((w) => w.phase === "specific" && !w.cut).map((w) => w.long);
    expect(Math.min(...spec)).toBeLessThan(longest * 0.85);
  });
  it("says what each session trains", () => {
    const r = buildPlan(BUNDLED_PLAN, o, h, "2026-11-06");
    const from = r.weeks[0].monday;
    const s = r.plan.weeks.filter((w) => w.start >= from && w.start <= o.raceDate).flatMap((w) => Object.values(w.sessions) as string[]);
    expect(s.some((x) => /VO2 max: /.test(x))).toBe(true);
    expect(s.some((x) => /Threshold(?: tempo)?: /.test(x))).toBe(true);
    expect(s.filter((x) => / with /.test(x) && !/long run/.test(x) && !/(VO2 max|Threshold|Threshold tempo|Hill strength|Race pace): |fartlek|time trial/.test(x))).toEqual([]);
    // Every speed session has its warm-up and cool-down written in.
    expect(s.filter((x) => / with /.test(x) && !/long run|time trial/.test(x) && !/warm-up, .*cool-down$/.test(x))).toEqual([]);
  });
});

describe("create a workout", () => {
  it("every suggestion is a workout the watch understands, with its warm-up", async () => {
    const { FOCUSES, suggestions, specText } = await import("./workoutLibrary");
    const { pacesFor } = await import("./planBuilder");
    const p = pacesFor(53.6);
    for (const f of FOCUSES)
      for (const dist of ["marathon", "10k"] as const)
        for (const s of suggestions(f.id, p, dist)) {
          const text = specText(s);
          const w = sessionToWorkout(text);
          expect(w, text).not.toBeNull();
          if (!["long", "easy", "recovery"].includes(f.id)) expect(w!.steps.length, text).toBeGreaterThan(1);
          if (/warm-up/.test(text)) expect(JSON.stringify(w!.steps[0]), text).toMatch(/"3km"|"\d+km"/);
        }
  });
  it("suggests easy after a hard day and recovery when readiness is low", async () => {
    const { suggestFocus } = await import("./workoutLibrary");
    expect(suggestFocus({ readiness: 30, hardDaysAgo: 5, planToday: null, longDaysAgo: 2 }).focus).toBe("recovery");
    expect(suggestFocus({ readiness: 80, hardDaysAgo: 1, planToday: null, longDaysAgo: 2 }).focus).toBe("easy");
    expect(suggestFocus({ readiness: 80, hardDaysAgo: 5, planToday: null, longDaysAgo: 2 }).focus).toBe("threshold");
  });
});
