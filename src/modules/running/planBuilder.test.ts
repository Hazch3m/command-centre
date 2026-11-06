import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { sessionToWorkout } from "../watch/importWeek";
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

  it("only uses the kinds you pick", () => {
    const s = all({ ...base, tune: { kinds: ["fartlek", "racepace"] } });
    expect(s.some((x) => /fartlek/.test(x))).toBe(true);
    expect(s.some((x) => /progression run|hill reps|min T at/.test(x))).toBe(false);
  });

  it("ramps faster when you ask for it", () => {
    const slow = bp(BUNDLED_PLAN, { ...base, weeks: 30, tune: { growth: 0.03 } }, h, "2026-11-06").weeks;
    const fast = bp(BUNDLED_PLAN, { ...base, weeks: 30, tune: { growth: 0.1 } }, h, "2026-11-06").weeks;
    const peakAt = (ws: { km: number }[]) => ws.findIndex((w) => w.km >= Math.max(...ws.map((x) => x.km)) * 0.97);
    expect(peakAt(fast)).toBeLessThan(peakAt(slow));
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
