import type { Plan } from "./plan";
import { describe, expect, it } from "vitest";
import { mondayOf, sessionFor, upcomingRaces, weekFor } from "./plan";
import fixturePlan from "./plan.fixture.json";
const BUNDLED_PLAN = fixturePlan as unknown as Plan;
import { judgeBenchmark, marathonEquivalent, pace, parseTime, raceHistory, weekDays, weeklyTotals, yearSummary } from "./stats";
import type { Run } from "./strava";

const run = (id: string, date: string, distKm: number, secs: number, extra: Partial<Run> = {}): Run => ({
  id,
  date,
  start_local: date + "T08:00:00",
  name: "Run",
  sport: "Run",
  distance: distKm * 1000,
  moving_time: secs,
  elapsed_time: secs,
  elevation: 0,
  avg_hr: 145,
  max_hr: 170,
  workout_type: null,
  polyline: null,
  gear_id: null,
  ...extra,
});

describe("plan", () => {
  const plan = BUNDLED_PLAN;
  it("finds the week and its sessions", () => {
    expect(weekFor(plan, "2026-10-29")?.week).toBe("R1");
    expect(weekFor(plan, "2026-11-17")?.week).toBe("2");
    expect(sessionFor(plan, "2026-11-17")).toEqual({ text: "4 × 6 min T at 3:46–3:50, 1 min jog", key: true }); // Tuesday
    expect(sessionFor(plan, "2026-11-18")?.key).toBe(false); // Wednesday comes from the weekly structure
    expect(sessionFor(plan, "2026-11-18")?.text).toMatch(/strength A/);
    expect(sessionFor(plan, "2027-04-07")?.text).toMatch(/medium-long/i); // phase 3 Wednesday is a named session
  });
  it("counts down to races", () => {
    const next = upcomingRaces(plan, "2026-10-29");
    expect(next[0]).toMatchObject({ name: "5k time trial", days: 51 });
    expect(next.at(-1)).toMatchObject({ name: "Valencia Marathon", approx: true });
  });
  it("finds Mondays", () => {
    expect(mondayOf("2026-11-01")).toBe("2026-10-26");
    expect(mondayOf("2026-10-26")).toBe("2026-10-26");
  });
});

describe("stats", () => {
  const runs = [
    run("a", "2026-10-26", 8, 2900),
    run("b", "2026-10-28", 12.5, 4000),
    run("c", "2026-11-01", 21, 6600),
    run("d", "2026-11-03", 10, 3000),
  ];
  it("totals weeks including empty ones", () => {
    const w = weeklyTotals(runs, "2026-10-19", "2026-11-02");
    expect(w.map((x) => Math.round(x.km * 10) / 10)).toEqual([0, 41.5, 10]);
    expect(w[1]).toMatchObject({ runs: 3, longest: 21 });
  });
  it("lays out the current week by day", () => {
    const d = weekDays(runs, "2026-10-29");
    expect(d.map((x) => x.km)).toEqual([8, 0, 12.5, 0, 0, 0, 21]);
  });
  it("summarises the last year", () => {
    const s = yearSummary(runs, "2026-11-04");
    expect(s.weeks).toHaveLength(52);
    expect(s.weeksUnder15).toBe(51);
  });
  it("formats paces and times", () => {
    expect(pace(10000, 2400)).toBe("4:00");
    expect(parseTime("1:18:30")).toBe(4710);
    expect(parseTime("17:20 or faster")).toBe(1040);
    expect(Math.round(marathonEquivalent(37 * 60 + 15, 10) / 60)).toBe(171); // 37:15 10k ≈ 2:51
  });
  it("judges benchmarks", () => {
    const b = { name: "5k time trial", date: "2026-12-19", when: "19 Dec", onTrack: "17:20 or faster", behind: "slower than 17:40" };
    expect(judgeBenchmark(b, 17 * 60 + 10)).toBe("on-track");
    expect(judgeBenchmark(b, 17 * 60 + 30)).toBe("between");
    expect(judgeBenchmark(b, 17 * 60 + 50)).toBe("behind");
    expect(judgeBenchmark(b, null)).toBe("pending");
    expect(judgeBenchmark({ ...b, onTrack: "Heart rate mostly in the 170s" }, 100)).toBe("manual");
  });
  it("adds new Strava races after the curated list", () => {
    const rs = [run("20727686060", "2026-10-25", 42.3, 10785), run("z", "2026-12-19", 5.02, 1040, { workout_type: 1, name: "TT" })];
    const h = raceHistory(rs, BUNDLED_PLAN);
    expect(h.map((r) => [r.name, r.km])).toEqual([["Lausanne marathon", 42.195], ["TT", 5]]);
  });
});
