import { describe, expect, it } from "vitest";
import { forecastWeek, sessionKm, raceKm } from "./forecast";
import { BUNDLED_PLAN } from "./plan";

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

