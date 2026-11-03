import { describe, expect, it } from "vitest";
import { forecastWeek } from "./forecast";
import { collectEfforts, medalsByRun, pbTable } from "./pbs";
import { BUNDLED_PLAN, priorityOf } from "./plan";
import { applyRaceTapers } from "./planAdjust";
import { csvToWeeks, mergeImported, parseDate } from "./planCsv";
import { raceReadiness } from "./readiness";
import type { Run, RunDetail } from "./strava";

const run = (id: string, date: string, km: number, secs: number, extra: Partial<Run> = {}): Run => ({
  id, date, start_local: `${date}T08:00`, name: `Run ${id}`, sport: "Run", distance: km * 1000, moving_time: secs, elapsed_time: secs, elevation: 0, avg_hr: null, max_hr: null, workout_type: null, polyline: null, gear_id: null, ...extra,
});

describe("PBs and medals", () => {
  const runs = [run("a", "2026-01-01", 10, 2400), run("b", "2026-02-01", 10, 2300), run("c", "2026-03-01", 10, 2350), run("d", "2026-04-01", 5.02, 1150, { workout_type: 1 })];
  const details = new Map<string, RunDetail>([
    ["a", { splits: [], bestEfforts: [{ name: "5K", time: 1190 }, { name: "10K", time: 2400 }] }],
    ["b", { splits: [], bestEfforts: [{ name: "5K", time: 1150 }, { name: "10K", time: 2300 }] }],
    ["c", { splits: [], bestEfforts: [{ name: "5K", time: 1170 }, { name: "10K", time: 2350 }] }],
  ]);
  const efforts = collectEfforts(runs, details);
  it("counts whole race-distance runs as efforts", () => {
    expect(efforts.filter((e) => e.runId === "d" && e.name === "5K")).toHaveLength(1);
  });
  it("gives medals against earlier runs, like Strava", () => {
    const m = medalsByRun(efforts);
    expect(m.get("a")!.map((x) => x.rank)).toEqual([1, 1]);
    expect(m.get("b")!.every((x) => x.rank === 1)).toBe(true);
    expect(m.get("c")!.find((x) => x.name === "10K")!.rank).toBe(2);
  });
  it("lists PBs and how they came down", () => {
    const t = pbTable(efforts, "2026-11-03");
    const tenk = t.find((r) => r.name === "10K")!;
    expect(tenk.top[0].seconds).toBe(2300);
    expect(tenk.progression.map((e) => e.seconds)).toEqual([2400, 2300]);
  });
});

describe("races", () => {
  it("works out priorities from the plan's roles", () => {
    expect(priorityOf({ date: null, approx: false, when: "", name: "Edinburgh Marathon", target: "", role: "Sub-2:50 attempt" })).toBe("A");
    expect(priorityOf({ date: null, approx: false, when: "", name: "5k time trial", target: "", role: "First benchmark" })).toBe("C");
    expect(priorityOf({ date: null, approx: false, when: "", name: "Lausanne half", target: "", role: "Autumn test" })).toBe("B");
  });
  it("applies a mini taper: easier race week, no hard days just before", () => {
    const plan = { ...BUNDLED_PLAN, races: [...BUNDLED_PLAN.races, { date: "2027-03-07", approx: false, when: "", name: "Test half", target: "", role: "", taper: "mini" as const, km: 21.1 }] };
    const after = applyRaceTapers(plan);
    const before = forecastWeek(plan, "2027-03-01");
    const week = forecastWeek(after, "2027-03-01");
    expect(week.plannedKm!).toBeLessThan(before.plannedKm!);
    for (const d of week.days.slice(3, 6)) expect(d.kind === "key").toBe(false);
    expect(after.baseWeeks).toBe(BUNDLED_PLAN.weeks);
  });
});

describe("CSV import and readiness", () => {
  it("reads dates in several styles", () => {
    expect(parseDate("2027-01-04")).toBe("2027-01-04");
    expect(parseDate("04/01/2027")).toBe("2027-01-04");
    expect(parseDate("4 Jan 2027")).toBe("2027-01-04");
  });
  it("reads a day-per-row CSV and rates its readiness", () => {
    const rows = ["date,workout,distance_km"];
    for (let w = 0; w < 16; w++) {
      const m = new Date(Date.UTC(2027, 0, 4 + w * 7));
      const d = (i: number) => new Date(m.getTime() + i * 86400000).toISOString().slice(0, 10);
      const k = Math.min(90, 50 + w * 4) * (w >= 14 ? 0.6 : 1);
      rows.push(`${d(1)},6 x 1km at 3:40 2 min jog,${Math.round(k * 0.18)}`, `${d(2)},Easy,${Math.round(k * 0.18)}`, `${d(3)},20 min T at 3:50,${Math.round(k * 0.15)}`, `${d(5)},Easy,${Math.round(k * 0.14)}`);
      rows.push(w === 15 ? `${d(6)},Marathon race,42.2` : `${d(6)},Long run at MP finish,${Math.round(Math.min(32, k * 0.35))}`);
    }
    const imp = csvToWeeks(rows.join("\n"));
    expect(imp.layout).toBe("days");
    expect(imp.weeks).toHaveLength(16);
    expect(imp.raceRows.map((r) => r.text)).toContain("Marathon race");
    const race = { date: imp.raceRows[imp.raceRows.length - 1].date, approx: false, when: "", name: "Goal", target: "3:00", role: "", km: 42.2 };
    const plan = mergeImported(BUNDLED_PLAN, imp, race, "plan.csv", "2026-11-03");
    const r = raceReadiness(plan, race, "2026-11-03", () => 50)!;
    expect(r.score).toBeGreaterThan(40);
    expect(r.parts).toHaveLength(5);
    expect(r.predicted!).toBeGreaterThan(3 * 3600 - 900);
    expect(plan.previous?.title).toBe(BUNDLED_PLAN.title);
  });
  it("reads a week-per-row CSV", () => {
    const imp = csvToWeeks("week_start,mon,tue,wed,thu,fri,sat,sun\n2027-01-04,Rest,12 km with 5 × 1 km at 3:30,10 km easy,Rest,8 km easy,Rest,20 km long run");
    expect(imp.layout).toBe("weeks");
    expect(imp.weeks[0].sessions.sun).toBe("20 km long run");
  });
});
