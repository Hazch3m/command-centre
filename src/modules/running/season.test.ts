import { describe, expect, it } from "vitest";
import { segmentSeason, seasonLabel, type SeasonPhase } from "./season";

// Harry's season (spec v1.2, regression inputs). Expected (from the "Valencia plan v2" tab):
//   rebuild and sharpen 16 Nov–20 Dec · threshold base 21 Dec–31 Jan · VO2 max 1 Feb–28 Mar ·
//   Edinburgh-specific 29 Mar–16 May · taper 17–30 May · recovery 31 May–20 Jun ·
//   VO2 max 21 Jun–15 Aug · Valencia-specific 16 Aug–14 Nov · taper 15 Nov–5 Dec   (each ±1 week)
const others = [
  { name: "5k", date: "2026-12-19" },
  { name: "Antigel 10k", date: "2027-02-07" },
  { name: "Aix 10k", date: "2027-03-28" },
  { name: "Killarney half", date: "2027-05-08" },
  { name: "Summer 10k", date: "2027-07-18", uncertainty: 7 },
  { name: "Lausanne half", date: "2027-10-24" },
];
const harry = (start: string) =>
  segmentSeason({
    start,
    primary: { name: "Valencia marathon", date: "2027-12-05" },
    secondaries: [{ name: "Edinburgh marathon", date: "2027-05-30" }],
    others,
    lastMarathon: "2026-10-25",
  });
const weeksApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / (7 * 864e5);
const expectPhase = (ph: SeasonPhase[], kind: string, race: string | undefined, from: string, to: string) => {
  const p = ph.find((x) => x.kind === kind && (race === undefined || x.race === race) && weeksApart(x.from, from) <= 1);
  expect(p, `${kind} ${race ?? ""} from ${from}`).toBeTruthy();
  expect(weeksApart(p!.to, to), `${kind} ends ${to}`).toBeLessThanOrEqual(1);
};

describe("season segmentation", () => {
  it("reproduces v2's phases from 16 November (±1 week)", () => {
    const ph = harry("2026-11-16");
    expectPhase(ph, "opening", undefined, "2026-11-16", "2026-12-14");
    expectPhase(ph, "base", "Edinburgh marathon", "2026-12-21", "2027-01-25");
    expectPhase(ph, "vo2", "Edinburgh marathon", "2027-02-01", "2027-03-22");
    expectPhase(ph, "specific", "Edinburgh marathon", "2027-03-29", "2027-05-10");
    expectPhase(ph, "taper", "Edinburgh marathon", "2027-05-17", "2027-05-24");
    expectPhase(ph, "recovery", "Edinburgh marathon", "2027-05-31", "2027-06-14");
    expectPhase(ph, "vo2", "Valencia marathon", "2027-06-21", "2027-08-09");
    expectPhase(ph, "specific", "Valencia marathon", "2027-08-16", "2027-11-08");
    expectPhase(ph, "taper", "Valencia marathon", "2027-11-15", "2027-11-29");
    // Contiguous, no gaps or overlaps.
    for (let i = 1; i < ph.length; i++) expect(weeksApart(ph[i - 1].to, ph[i].from)).toBe(1);
    expect(ph.map((p) => seasonLabel(p, "Valencia marathon"))).toContain("Edinburgh-specific");
  });

  it("follows the spec's rules for lengths", () => {
    const ph = harry("2026-11-16");
    const len = (kind: string, race: string) => ph.find((p) => p.kind === kind && p.race === race)!.weeks;
    expect(len("taper", "Valencia marathon")).toBe(3);
    expect(len("taper", "Edinburgh marathon")).toBe(2);
    expect(len("recovery", "Edinburgh marathon")).toBe(3);
    expect(len("specific", "Edinburgh marathon")).toBeGreaterThanOrEqual(6);
    expect(len("specific", "Edinburgh marathon")).toBeLessThanOrEqual(8);
    expect(len("specific", "Valencia marathon")).toBeGreaterThanOrEqual(10);
    expect(len("specific", "Valencia marathon")).toBeLessThanOrEqual(13);
    // No threshold base after the recovery phase.
    expect(ph.filter((p) => p.kind === "base").every((p) => p.race === "Edinburgh marathon")).toBe(true);
    // The Edinburgh block starts the day after Aix (a block ends with a B race week).
    expect(ph.find((p) => p.kind === "specific" && p.race === "Edinburgh marathon")!.from).toBe("2027-03-29");
  });

  it("rebuilt a week later, the opening phase still runs to the 5k and the rest stays put", () => {
    const ph = harry("2026-11-23");
    expect(ph[0]).toMatchObject({ kind: "opening", from: "2026-11-23", to: "2026-12-14" });
    expectPhase(ph, "specific", "Edinburgh marathon", "2027-03-29", "2027-05-10");
    expectPhase(ph, "specific", "Valencia marathon", "2027-08-16", "2027-11-08");
  });

  it("a single marathon: base, VO2 max, specific, taper; the middle of each range without races", () => {
    const ph = segmentSeason({ start: "2027-01-04", primary: { name: "Berlin marathon", date: "2027-09-26" } });
    expect(ph.map((p) => p.kind)).toEqual(["base", "vo2", "specific", "taper"]);
    expect(ph.find((p) => p.kind === "specific")!.weeks).toBe(12);
    expect(ph.find((p) => p.kind === "vo2")!.weeks).toBe(7);
  });

  it("short of time: the base goes first, then the VO2 max block; the specific block keeps its minimum", () => {
    const ph = segmentSeason({ start: "2027-06-07", primary: { name: "Berlin marathon", date: "2027-09-26" } });
    expect(ph.find((p) => p.kind === "base")).toBeUndefined();
    expect(ph.find((p) => p.kind === "specific")!.weeks).toBeGreaterThanOrEqual(8);
  });
});

import { buildPlan } from "./planBuilder";
import { BUNDLED_PLAN } from "./plan";
import { sessionToWorkout } from "../watch/importWeek";

describe("the builder follows the season (Harry's inputs)", () => {
  const R = (date: string, name: string, km: number, priority: "A" | "B" | "C", target = "", approx = false) => ({ date, approx, when: date, name, km, priority, target, role: "Tune-up" });
  const old = {
    ...BUNDLED_PLAN,
    races: [R("2026-10-25", "Lausanne marathon", 42.2, "A"), R("2026-12-19", "5k", 5, "B"), R("2027-02-07", "Antigel 10k", 10, "B"), R("2027-03-28", "Aix 10k", 10, "B"), R("2027-05-08", "Killarney half", 21.1, "B"), R("2027-05-30", "Edinburgh marathon", 42.2, "A", "2:49:59"), R("2027-07-18", "Summer 10k", 10, "B", "", true), R("2027-10-24", "Lausanne half", 21.1, "B")],
  };
  const r = buildPlan(
    old,
    { raceName: "Valencia marathon", raceDate: "2027-12-05", dist: "marathon", target: "2:39:00", weeks: 60, level: "elite", days: 6, longDay: "sun", keepRaces: true, tune: { peakKm: 120, startKm: 64 }, hr: { max: 199, lthr: 188 } },
    { recent4: 40, recent12: 43, peak12: 61, runsPerWeek: 5, longest8: 21, weeksRun12: 12, vdot: 57 },
    "2026-11-15",
  );

  it("names the phases as v2 does, on v2's dates (±1 week)", () => {
    const ph = (name: string) => r.plan.phases.find((p) => p.name === name);
    const close = (a: string | null | undefined, b: string) => expect(a && weeksApart(a, b), `${a} vs ${b}`).toBeLessThanOrEqual(1);
    close(ph("Rebuild and sharpen")?.start, "2026-11-16");
    close(ph("Threshold base")?.start, "2026-12-21");
    close(ph("Edinburgh-specific")?.start, "2027-03-29");
    close(ph("Edinburgh taper")?.start, "2027-05-17");
    close(ph("Recovery")?.start, "2027-05-31");
    close(ph("Valencia-specific")?.start, "2027-08-16");
    close(ph("Taper")?.start, "2027-11-15");
    const vo2 = r.plan.phases.filter((p) => p.name === "VO2 max block");
    expect(vo2).toHaveLength(2);
    close(vo2[0].start, "2027-02-01");
    close(vo2[1].start, "2027-06-21");
    // Each week carries its phase's name.
    expect(r.plan.weeks.find((w) => w.start === "2027-04-12")!.phase).toBe("Edinburgh-specific");
  });

  it("opens with VO2 max long reps and threshold, then sharpens for the 5k", () => {
    const s = (d: string) => Object.values(r.plan.weeks.find((w) => w.start === d)!.sessions) as string[];
    expect(s("2026-11-16").some((x) => /VO2 max: 4 × 4 min/.test(x))).toBe(true);
    expect(s("2026-11-16").some((x) => /Threshold: 4 × 2 km/.test(x))).toBe(true);
    expect(s("2026-11-30").some((x) => /30\/15s: 3 sets of 10 × 30 s/.test(x))).toBe(true);
    expect(s("2026-12-14").some((x) => /5K pace: 5 × 1 km/.test(x))).toBe(true);
  });

  it("recovers 3 weeks after Edinburgh: easy only, then strides, then one light session, then ramps back", () => {
    const wk = (d: string) => r.weeks.find((w) => w.monday === d)!;
    const s = (d: string) => Object.values(r.plan.weeks.find((w) => w.start === d)!.sessions) as string[];
    expect(s("2027-05-31").some((x) => / with |fartlek|strides/.test(x))).toBe(false);
    expect(s("2027-06-07").some((x) => /strides/.test(x))).toBe(true);
    expect(s("2027-06-07").some((x) => / with 3 km warm-up|fartlek at/.test(x))).toBe(false);
    expect(s("2027-06-14").filter((x) => /fartlek at/.test(x))).toHaveLength(1);
    expect(wk("2027-06-21").km).toBeLessThanOrEqual(Math.round(wk("2027-06-14").km * 1.25) + 1);
    expect(wk("2027-06-21").long).toBeLessThanOrEqual(wk("2027-06-14").long + 3);
  });

  it("30/15 sets go to the watch as three sets", () => {
    const w = sessionToWorkout("11 km with 3 km warm-up, VO2 max: 30/15s: 3 sets of 10 × 30 s at 3:15–3:19, 15 s jog, 3 min between sets, 2 km cool-down")!;
    const reps = w.steps.filter((x) => (x as { kind?: string }).kind === "repeat");
    expect(reps).toHaveLength(3);
    expect(w.steps.some((x) => (x as { duration?: string }).duration === "3:00")).toBe(true);
  });
});
