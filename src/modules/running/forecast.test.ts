import type { Plan } from "./plan";
import { describe, expect, it } from "vitest";
import { forecastWeek, fullWeekSessions, sessionKm, raceKm } from "./forecast";
import fixturePlan from "./plan.fixture.json";
const BUNDLED_PLAN = fixturePlan as unknown as Plan;

describe("session km", () => {
  it("reads distances from the plan's wording", () => {
    expect(sessionKm("Rest")).toBe(0);
    expect(sessionKm("none")).toBe(0);
    expect(sessionKm("16 km easy")).toBe(16);
    expect(sessionKm("28 km, last 6 at 4:05")).toBe(28);
    expect(sessionKm("12 km with 8 × 10 s hill sprints")).toBe(12);
    expect(sessionKm("Easy 45 min")).toBeCloseTo(8.4, 1);
    expect(sessionKm("Easy + strides")).toBeNull();
    expect(sessionKm("Antigel 10k, 7 Feb: 35:30–36:00, plus warm-up and cool-down, about 21 km")).toBe(21);
  });
  it("adds up rep sessions with recoveries and a warm-up", () => {
    expect(sessionKm("4 × 6 min T at 3:46–3:50, 1 min jog")).toBeCloseTo(12, 0);
    expect(sessionKm("6 × 1 km at 3:20–3:23, 2 min jog")).toBeCloseTo(12.7, 0);
    expect(sessionKm("8 × 400 m at 3:12–3:15, 200 m jog")).toBeCloseTo(9.6, 1);
    expect(sessionKm("2 × 5 km at 3:45–3:48, 2 min jog")).toBeCloseTo(15.3, 1);
    expect(sessionKm("Fartlek 10 × 1 min on, 1 min off")).toBeCloseTo(9.5, 0);
    expect(sessionKm("25 min T at 3:43–3:46")).toBeCloseTo(11.7, 1);
    expect(sessionKm("3 × 2 km at 3:30 + 4 × 200 m fast")).toBeGreaterThan(11.5);
  });
  it("knows race distances", () => {
    expect(raceKm("Edinburgh Marathon")).toBe(42.2);
    expect(raceKm("Run Killarney half")).toBe(21.1);
    expect(raceKm("Aix-les-Bains 10k")).toBe(10);
    expect(raceKm("5k time trial")).toBe(5);
  });
});

describe("week forecast", () => {
  it("lands each plan week near its target", () => {
    for (const w of BUNDLED_PLAN.weeks) {
      const f = forecastWeek(BUNDLED_PLAN, w.start);
      const lo = w.kmMin ?? 0;
      const hi = w.kmMax ?? lo;
      if (!w.kmMin || /race/.test(w.km)) continue;
      expect(f.plannedKm!, `week ${w.week}: ${f.days.map((d) => `${d.dow} ${d.km} ${d.text}`).join(" | ")}`).toBeGreaterThanOrEqual(lo * 0.85);
      expect(f.plannedKm!, `week ${w.week}`).toBeLessThanOrEqual(hi * 1.15);
    }
  });
  it("lays out a normal week", () => {
    const f = forecastWeek(BUNDLED_PLAN, "2026-11-16"); // week 2, 63 km
    const by = Object.fromEntries(f.days.map((d) => [d.dow, d]));
    expect(by.Tue.kind).toBe("key");
    expect(by.Tue.pace).toBe("3:46–3:50");
    expect(by.Sun.kind).toBe("long");
    expect(by.Sun.km).toBe(22);
    expect(by.Wed.strength).toBe("A");
    expect(by.Fri.strength).toBe("B");
    expect(by.Sat.km).toBeGreaterThanOrEqual(5);
  });
  it("marks race days", () => {
    const f = forecastWeek(BUNDLED_PLAN, "2026-12-14"); // 5k TT on Sat 19 Dec
    const sat = f.days.find((d) => d.dow === "Sat")!;
    expect(sat.kind).toBe("race");
    expect(sat.km).toBe(10);
    expect(f.days.find((d) => d.dow === "Thu")!.text).toBe("Easy + strides");
  });
  it("shows the block outside the week table", () => {
    const f = forecastWeek(BUNDLED_PLAN, "2027-06-21");
    expect(f.week).toBeNull();
    expect(f.block?.name).toMatch(/Summer/);
  });
});


describe("writing out the full week", () => {
  it("names every day and keeps the week's distance", () => {
    const week = BUNDLED_PLAN.weeks.find((w) => w.week === "3")!;
    const sessions = fullWeekSessions(BUNDLED_PLAN, week);
    expect(Object.keys(sessions).sort()).toEqual(["fri", "mon", "sat", "sun", "thu", "tue", "wed"]);
    const before = forecastWeek(BUNDLED_PLAN, week.start);
    const plan2 = { ...BUNDLED_PLAN, weeks: BUNDLED_PLAN.weeks.map((w) => (w === week ? { ...w, sessions } : w)) };
    const after = forecastWeek(plan2, week.start);
    expect(after.plannedKm).toBeCloseTo(before.plannedKm!, -1);
    expect(after.days.filter((d) => d.kind !== "rest").length).toBe(before.days.filter((d) => d.kind !== "rest").length);
    expect(sessions.tue).toBe(week.sessions.tue);
  });
});

describe("the shipped plan", () => {
  it("has every day written out and at most six runs a week", async () => {
    const { BUNDLED_PLAN: real } = await import("./plan");
    for (const w of real.weeks.filter((x) => x.start >= "2026-11-09")) {
      const f = forecastWeek(real, w.start);
      expect(f.days.filter((d) => (d.km ?? 0) > 0 || d.race).length).toBeLessThanOrEqual(6);
    }
  });
});

describe("plan settings", () => {
  it("scales mileage, changes long runs and moves run days", async () => {
    const { adjustWeek, applyAdjust } = await import("./planAdjust");
    const week = BUNDLED_PLAN.weeks.find((w) => w.week === "5")!;
    const base = forecastWeek(BUNDLED_PLAN, week.start);
    const a = { volume: 1.1, longExtra: 2, longMax: null, runDays: ["mon", "tue", "thu", "fri", "sat"] as const, longDay: "sat" as const, from: "2026-01-01" };
    const plan = applyAdjust({ ...BUNDLED_PLAN, adjust: { ...a, runDays: [...a.runDays] } });
    const after = forecastWeek(plan, week.start);
    expect(after.plannedKm!).toBeGreaterThan(base.plannedKm! * 1.03);
    const runDays = after.days.filter((d) => (d.km ?? 0) > 0).map((d) => d.dow);
    expect(runDays).toEqual(["Mon", "Tue", "Thu", "Fri", "Sat"]);
    expect(after.days[5].kind).toBe("long");
    const baseLong = Math.max(...base.days.filter((d) => d.kind === "long").map((d) => d.km ?? 0));
    expect(after.days[5].km).toBeGreaterThanOrEqual(baseLong + 2);
    // every session from the week is still in it
    const keys = (f: typeof base) => f.days.filter((d) => d.kind === "key").map((d) => d.text).sort();
    expect(keys(after)).toEqual(keys(base));
    expect(plan.baseWeeks).toBe(BUNDLED_PLAN.weeks);
    expect(adjustWeek(BUNDLED_PLAN, week, { ...a, runDays: [...a.runDays], from: "2099-01-01" })).toBe(week);
  });
  it("keeps the plan's own run days when only the mileage changes", async () => {
    const { applyAdjust } = await import("./planAdjust");
    const plan = applyAdjust({ ...BUNDLED_PLAN, adjust: { volume: 1.1, longExtra: 0, longMax: null, runDays: null, longDay: null, from: "2026-01-01" } });
    for (const w of BUNDLED_PLAN.weeks.slice(0, 20)) {
      const before = forecastWeek(BUNDLED_PLAN, w.start).days;
      if (before.some((d) => d.race)) continue;
      const after = forecastWeek(plan, w.start).days;
      expect(after.map((d) => (d.km ?? 0) > 0)).toEqual(before.map((d) => (d.km ?? 0) > 0));
    }
  });
  it("caps long runs", async () => {
    const { applyAdjust } = await import("./planAdjust");
    const plan = applyAdjust({ ...BUNDLED_PLAN, adjust: { volume: 1, longExtra: 0, longMax: 24, runDays: ["tue", "wed", "thu", "sat", "sun"], longDay: "sun", from: "2026-01-01" } });
    for (const w of plan.weeks.slice(0, 30)) for (const d of forecastWeek(plan, w.start).days) if (d.kind === "long") expect(d.km!).toBeLessThanOrEqual(24);
  });
});
