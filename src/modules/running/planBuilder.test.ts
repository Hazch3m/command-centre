import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { sessionToWorkout } from "../watch/importWeek";
import { BUNDLED_PLAN, WEEK_KEYS } from "./plan";
import { raceKey, sessionShape, buildPlan, doublesAdvice, LEVELS, pacesFor, recommend, type BuildOptions, type History } from "./planBuilder";

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
    const tune = { date: "2027-07-18", approx: false, when: "", name: "Summer 10k", target: "", role: "tune-up", priority: "B" as const, km: 10 };
    const o = { ...base, extraRaces: [tune] };
    const r = bp(BUNDLED_PLAN, o, h, "2026-11-06");
    const before = r.plan.weeks.filter((w) => w.start >= "2027-06-28" && w.start <= "2027-07-05").flatMap((w) => Object.values(w.sessions) as string[]);
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
    expect(s.filter((x) => / with /.test(x) && !/long run/.test(x) && !/(VO2 max|Threshold|Threshold tempo|Hill strength|Race pace|Marathon pace): |fartlek|time trial/.test(x))).toEqual([]);
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

describe("Start running", () => {
  it("builds nine weeks of run/walk to 30 minutes, three days a week, with no history", () => {
    const h: History = { recent4: 0, recent12: 0, peak12: 0, runsPerWeek: 0, longest8: 0, weeksRun12: 0, vdot: null };
    const o: BuildOptions = { raceName: "Start running", raceDate: "2027-03-01", dist: "5k", target: "", weeks: 9, level: "beginner", days: 3, longDay: "sun", keepRaces: false, goal: "start" };
    const { plan, weeks } = buildPlan(BUNDLED_PLAN, o, h, "2026-11-11");
    expect(weeks).toHaveLength(9);
    const first = plan.weeks.find((w) => w.start === weeks[0].monday)!;
    const last = plan.weeks.find((w) => w.start === weeks[8].monday)!;
    expect(Object.values(first.sessions).filter((x) => /run\/walk/.test(x ?? ""))).toHaveLength(3);
    expect(first.sessions.tue).toMatch(/8 × 1 min run, 90 s walk/);
    expect(last.sessions.sun).toMatch(/30 min run without stopping/);
    expect(forecastWeek).toBeDefined();
    expect(plan.title).toBe("Start running: 9 weeks");
  });
});

describe("Beyond 5k", () => {
  it("builds ten weeks from a 35-minute 5k: three runs, long run to 9 km, a time trial at the end", () => {
    const h: History = { recent4: 0, recent12: 0, peak12: 0, runsPerWeek: 0, longest8: 0, weeksRun12: 0, vdot: null };
    const o: BuildOptions = { raceName: "Beyond 5k", raceDate: "2027-03-01", dist: "5k", target: "35:00", weeks: 10, level: "beginner", days: 3, longDay: "sun", keepRaces: false, goal: "beyond5k" };
    const { plan, weeks } = buildPlan(BUNDLED_PLAN, o, h, "2026-11-11");
    expect(weeks).toHaveLength(10);
    const ws = weeks.map((b) => plan.weeks.find((w) => w.start === b.monday)!);
    for (const w of ws) expect(Object.values(w.sessions).filter((x) => x !== "Rest")).toHaveLength(3);
    expect(Math.max(...weeks.map((b) => b.long))).toBe(9);
    expect(ws[9].sessions.sun).toMatch(/5 km time trial/);
    expect(ws[0].sessions.tue).toMatch(/fartlek/);
    expect(plan.built!.vdot).toBeGreaterThan(24);
    expect(plan.built!.vdot).toBeLessThan(30);
  });
});

describe("plan builder: a marathon on the way, and the year-round extras", () => {
  // Valencia in December with Edinburgh (A) in May: the critique's case.
  const h: History = { recent4: 35, recent12: 43, peak12: 60, runsPerWeek: 5, longest8: 21, weeksRun12: 12, vdot: 56 };
  const R = (date: string, name: string, km: number, priority: "A" | "B" | "C", target = "") => ({ date, approx: false, when: date, name, km, priority, target, role: "Tune-up" });
  const o: BuildOptions = {
    raceName: "Valencia",
    raceDate: "2027-12-05",
    dist: "marathon",
    target: "2:39",
    weeks: 60,
    level: "elite",
    days: 6,
    longDay: "sun",
    keepRaces: false,
    tune: { peakKm: 111 },
    extraRaces: [R("2027-03-28", "Aix 10k", 10, "B"), R("2027-05-30", "Edinburgh marathon", 42.2, "A", "2:49:59")],
  };
  const r = buildPlan({ ...BUNDLED_PLAN, races: [] }, o, h, "2026-11-15");
  const pw = r.plan.weeks.filter((w) => w.start >= r.weeks[0].monday && w.start <= o.raceDate);
  const at = (a: string) => r.weeks.findIndex((w) => w.around?.at === a);

  it("tapers for it, races it, and recovers before building again", () => {
    expect(["taper2", "taper1", "race", "recover1", "recover2"].map(at)).toEqual([at("taper2"), at("taper2") + 1, at("taper2") + 2, at("taper2") + 3, at("taper2") + 4]);
    expect(r.weeks[at("race")].monday).toBe("2027-05-24");
    const before = r.weeks[at("taper2") - 1].km;
    expect(r.weeks[at("taper1")].km).toBeLessThan(before * 0.75);
    // The week after: easy only, no sessions, no medium-long run.
    const after = Object.values(pw[at("recover1")].sessions) as string[];
    expect(after.filter((x) => / with |medium-long|MP|strides/.test(x))).toEqual([]);
    expect(pw[at("taper1")].sessions.tue).toMatch(/^.*Marathon pace: 2 × 3 km at MP/);
    // Volume is back to normal a week after the second easy week, and no easier week straight away.
    expect(r.weeks[at("recover2") + 1].cut).toBe(false);
  });

  it("puts marathon pace in its long runs beforehand, growing towards 22 km", () => {
    const mp = pw.slice(0, at("taper2")).map((w) => /last (\d+(?:\.\d+)?) at MP|(\d) × 5 km at MP/.exec(w.sessions.sun ?? "")).filter(Boolean);
    expect(mp.length).toBeGreaterThanOrEqual(2);
  });

  it("builds to a plateau first and doesn't make every long run a huge one", () => {
    // Most of the peak by spring, the rest after Edinburgh.
    const spring = r.weeks.filter((w) => w.monday >= "2027-03-01" && w.monday < "2027-05-01" && !w.cut).map((w) => w.km);
    expect(Math.max(...spring)).toBeGreaterThan(85);
    expect(Math.max(...spring)).toBeLessThan(105);
    const big = r.weeks.map((w, i) => (w.long >= 32 ? i : -9)).filter((i) => i >= 0);
    expect(big.some((i, j) => j > 0 && i - big[j - 1] === 1)).toBe(false);
    expect(r.weeks.filter((w) => w.long >= 34).length).toBeLessThan(10);
  });

  it("has strides twice a week, strength twice a week, and VO2 max reps every few weeks", () => {
    const normal = pw.filter((_, i) => !r.weeks[i].around && r.weeks[i].phase !== "taper" && r.weeks[i].phase !== "race");
    const count = (w: (typeof pw)[number], re: RegExp) => (Object.values(w.sessions) as string[]).filter((x) => re.test(x)).length;
    expect(normal.filter((w) => count(w, /strides/) >= 2).length).toBeGreaterThan(normal.length * 0.8);
    expect(normal.filter((w) => count(w, /strength \(/) === 2).length).toBeGreaterThan(normal.length * 0.7);
    // (Edinburgh's last eight weeks are its own: marathon pace, taper and recovery.)
    for (const [from, to] of [["2026-11-16", "2027-04-01"], ["2027-06-14", "2027-08-23"]]) {
      const vo2 = pw.map((w, i) => (w.start >= from && w.start < to && count(w, /VO2 max: /) ? i : -1)).filter((i) => i >= 0);
      expect(Math.max(...vo2.slice(1).map((g, j) => g - vo2[j])), from).toBeLessThanOrEqual(4);
    }
    const off = buildPlan({ ...BUNDLED_PLAN, races: [] }, { ...o, tune: { ...o.tune, strength: false } }, h, "2026-11-15");
    expect(off.plan.weeks.some((w) => (Object.values(w.sessions) as string[]).some((x) => /strength \(/.test(x)))).toBe(false);
  });

  it("every session still goes to the watch", () => {
    for (const w of pw)
      for (const x of Object.values(w.sessions) as string[]) {
        if (/^Rest$|race$|Marathon$|marathon$|10k$/i.test(x)) continue;
        expect(sessionToWorkout(x), x).not.toBeNull();
      }
  });
});

describe("plan builder: changing the races already in your plan", () => {
  const h: History = { recent4: 35, recent12: 43, peak12: 60, runsPerWeek: 5, longest8: 21, weeksRun12: 12, vdot: 56 };
  const R = (date: string, name: string, km: number, priority: "A" | "B" | "C", target = "") => ({ date, approx: false, when: date, name, km, priority, target, role: "Tune-up" });
  const edin = R("2027-05-30", "Edinburgh marathon", 42.2, "B");
  const laus = R("2027-10-24", "Lausanne marathon", 42.2, "A", "2:45");
  const old = { ...BUNDLED_PLAN, races: [edin, laus] };
  const o: BuildOptions = { raceName: "Valencia", raceDate: "2027-12-05", dist: "marathon", target: "2:39", weeks: 60, level: "elite", days: 6, longDay: "sun", keepRaces: true };

  it("makes Edinburgh an A race and Lausanne a half, and undo keeps the old races", () => {
    const r = buildPlan(old, { ...o, raceEdits: { [raceKey(edin)]: { priority: "A", target: "2:49:59" }, [raceKey(laus)]: { km: 21.1, name: "Lausanne half", priority: "B", target: "" } } }, h, "2026-11-15");
    const names = r.plan.races.map((x) => `${x.name} ${x.priority} ${x.km ?? ""}`);
    expect(names).toContain("Edinburgh marathon A 42.2");
    expect(names).toContain("Lausanne half B 21.1");
    expect(names.some((n) => n.startsWith("Lausanne marathon"))).toBe(false);
    expect(r.weeks.some((w) => w.around?.at === "taper2")).toBe(true);
    // Lausanne is now a half: no marathon taper or recovery around it.
    expect(r.weeks.filter((w) => w.around).every((w) => w.around!.race === "Edinburgh marathon")).toBe(true);
    expect(r.plan.previous?.races?.map((x) => x.name)).toEqual(["Edinburgh marathon", "Lausanne marathon"]);
  });

  it("plans a race named as a half as a half, even if its distance says marathon", () => {
    const halfAs42 = { ...laus, name: "Lausanne half marathon ", km: 42.2, priority: "B" as const };
    const r = buildPlan({ ...old, races: [edin, halfAs42] }, o, h, "2026-11-15");
    expect(r.weeks.filter((w) => w.around).every((w) => w.around!.race === "Edinburgh marathon")).toBe(true);
  });

  it("doesn't put VO2 max reps in a week that sharpens for a 5k", () => {
    const five = R("2026-12-19", "5k", 5, "B");
    const r = buildPlan({ ...old, races: [five, edin] }, o, h, "2026-11-15");
    for (const w of r.plan.weeks) {
      const v = Object.values(w.sessions) as string[];
      expect(v.some((x) => /5K pace: /.test(x)) && v.some((x) => /VO2 max: /.test(x)), w.start).toBe(false);
    }
  });

  it("runs Edinburgh's marathon-pace work at your fitness, or its own goal, not Valencia's goal pace", () => {
    const mpOf = (plan: ReturnType<typeof buildPlan>["plan"]) =>
      plan.weeks
        .filter((w) => w.start < "2027-05-30")
        .flatMap((w) => Object.values(w.sessions) as string[])
        .map((x) => /MP (\d):(\d\d)–(\d):(\d\d)/.exec(x))
        .filter(Boolean)
        .map((m) => (+m![1] * 60 + +m![2] + +m![3] * 60 + +m![4]) / 2);
    const fit = mpOf(buildPlan(old, { ...o, target: "2:30" }, h, "2026-11-15").plan);
    expect(fit.length).toBeGreaterThan(0);
    // 2:30 is 3:33/km; fitness MP at VDOT 56–58 is about 4:00.
    expect(Math.min(...fit)).toBeGreaterThan(230);
    const own = mpOf(buildPlan(old, { ...o, target: "2:30", raceEdits: { [raceKey(edin)]: { target: "2:49:59" } } }, h, "2026-11-15").plan);
    expect(own.every((x) => Math.abs(x - 241.7) <= 3)).toBe(true);
  });

  it("doesn't repeat last week's sessions in the first new week", () => {
    const first = buildPlan(old, o, h, "2026-11-15").plan.weeks.find((w) => w.start === "2026-11-16")!;
    // Pretend last week had exactly those sessions; the rebuilt first week must differ.
    const lastWeek = { ...first, start: "2026-11-09", end: "2026-11-15", week: "0" };
    const again = buildPlan({ ...old, weeks: [lastWeek, ...old.weeks.filter((w) => w.start > "2026-11-15")] }, o, h, "2026-11-15").plan.weeks.find((w) => w.start === "2026-11-16")!;
    const shapes = (w: typeof first) => (Object.values(w.sessions) as string[]).filter((x) => / with |progression/.test(x)).map(sessionShape);
    const before = new Set(shapes(lastWeek));
    expect(shapes(again).filter((x) => before.has(x))).toEqual([]);
    expect(sessionShape("11 km with 3 km warm-up, Threshold tempo: 23 min T at 3:48–3:52, 2 km cool-down")).toBe(sessionShape("11 km with 23 min T at 3:48–3:52"));
  });

  it("leaves out a race you remove", () => {
    const r = buildPlan(old, { ...o, raceEdits: { [raceKey(laus)]: null } }, h, "2026-11-15");
    expect(r.plan.races.map((x) => x.name)).toEqual(["Edinburgh marathon", "Valencia"]);
  });
});
