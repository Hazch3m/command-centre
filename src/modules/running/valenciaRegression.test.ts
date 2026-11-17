import { describe, expect, it } from "vitest";
import { buildPlan } from "./planBuilder";
import { BUNDLED_PLAN, type PlanRace } from "./plan";
import v2 from "./fixtures/valencia-v2.json";

/*
 * Regression test (plan generator spec v1.2, test 12): Harry's inputs against the "Valencia plan v2" tab
 * (fixtures/valencia-v2.json). VDOT 57, max HR 199, LTHR 188; start 16 Nov 2026 at 64 km, cap 120, no doubles;
 * Valencia 5 Dec 2027 (A-primary, 2:39), Edinburgh 30 May 2027 (A-secondary); B races 19 Dec 5k, 7 Feb 10k,
 * 28 Mar 10k, 8 May half, 18 Jul 10k, 24 Oct half.
 *
 * v2 counts a B race in its week's km, with its warm-up and cool-down (about 5 km); an A race is "+ race".
 */
const R = (date: string, name: string, km: number, priority: "A" | "B" | "C", target = ""): PlanRace => ({ date, approx: false, when: date, name, km, priority, target, role: "Tune-up" });
const races = [
  R("2026-10-25", "Lausanne marathon", 42.2, "A"),
  R("2026-12-19", "5k", 5, "B"),
  R("2027-02-07", "Antigel 10k", 10, "B"),
  R("2027-03-28", "Aix 10k", 10, "B"),
  R("2027-05-08", "Killarney half", 21.1, "B"),
  R("2027-05-30", "Edinburgh marathon", 42.2, "A", "2:49:59"),
  R("2027-07-18", "Summer 10k", 10, "B"),
  R("2027-10-24", "Lausanne half", 21.1, "B"),
];
const lastWeek = { week: "1", start: "2026-11-09", end: "2026-11-15", phase: "Base", km: "52", kmMin: 52, kmMax: 52, notes: "", sessions: { mon: "5 km recovery", tue: "11 km easy", wed: "5 km easy", thu: "11 km easy", fri: "Rest", sat: "5 km easy", sun: "15 km long run" } };
export const harryPlan = () =>
  buildPlan(
    { ...BUNDLED_PLAN, weeks: [lastWeek], races },
    { raceName: "Valencia marathon", raceDate: "2027-12-05", dist: "marathon", target: "2:39:00", weeks: 60, level: "elite", days: 6, longDay: "sun", keepRaces: true, tune: { peakKm: 120, startKm: 64, doubles: 0 }, hr: { max: 199, lthr: 188 } },
    { recent4: 40, recent12: 43, peak12: 61, runsPerWeek: 5, longest8: 21, weeksRun12: 12, vdot: 57 },
    "2026-11-15",
  );
const bRace = new Map(races.filter((r) => r.priority === "B").map((r) => [r.date!, r.km!]));
const raceKmIn = (start: string) => {
  for (const [d, km] of bRace) if (d >= start && d <= new Date(Date.parse(start) + 6 * 864e5).toISOString().slice(0, 10)) return km + 5;
  return 0;
};

describe("regression: Harry's inputs reproduce v2", () => {
  const { plan } = harryPlan();
  const rows = v2.map((f) => {
    const w = plan.weeks.find((x) => x.start === f.start)!;
    return { start: f.start, v2: f.km, ours: Math.round((w.kmMin ?? 0) + raceKmIn(f.start)), w };
  });

  it("weekly km within ±10% of v2 in at least 90% of weeks", () => {
    const off = rows.filter((r) => Math.abs(r.ours - r.v2) / r.v2 > 0.1);
    expect(off.length, off.map((r) => `${r.start}: ${r.ours} vs ${r.v2}`).join("; ")).toBeLessThanOrEqual(Math.floor(rows.length * 0.1));
  });

  it("spring peak ≤ 112, autumn peak ≤ 120", () => {
    expect(Math.max(...rows.filter((r) => r.start < "2027-05-30").map((r) => r.ours))).toBeLessThanOrEqual(112);
    expect(Math.max(...rows.map((r) => r.ours))).toBeLessThanOrEqual(120);
  });
});
