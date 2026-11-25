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
  { ...R("2027-07-18", "Summer 10k", 10, "B"), approx: true, when: "about 18 Jul" },
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

import { sessionToWorkout } from "../watch/importWeek";

// ---- Key-session types -----------------------------------------------------------------------------
// fast = VO2 max, 10k pace, 30/15s and race-week sharpeners at 5k/10k pace; threshold (half pace counts here);
// steady; mp = marathon pace; progression. v2's sessions have no labels, so each is matched to the nearest of
// the week's paces (threshold, marathon pace, VO2 max) as our plan sets them.
const secs = (m: RegExpExecArray | null) => (m ? +m[1] * 60 + +m[2] : null);
const ourType = (x: string): string | null => {
  if (/long run/.test(x)) return null;
  if (/km steady/.test(x)) return "steady";
  if (/progression run/.test(x)) return "progression";
  if (/Marathon pace:|Race pace:/.test(x)) return "mp";
  if (/Threshold|min T at|Half pace/.test(x)) return "threshold";
  if (/VO2 max:|10K pace:|5K pace:|30\/15|fartlek/.test(x)) return "fast";
  return null;
};
const v2Type = (raw: string, zones: { t: number; mp: number; v: number }): string | null => {
  const x = raw.replace(/^(Tue|Wed|Thu|Fri|Done): /, "");
  if (!/\d/.test(x) || /^—|strides|hill sprints|^Sun \d|^Sat \d|Summer 10k|Antigel 10k|Aix 10k|Killarney|Lausanne|Edinburgh|Valencia/.test(x)) return null;
  if (/30\/15/.test(x)) return "fast";
  if (/steady/.test(x)) return "steady";
  if (/last \d+ km at/.test(x)) return "progression";
  if (/\d+ km with \d+ km at/.test(x)) return "mp";
  const pace = secs(/at (?:about )?(\d):(\d\d)/.exec(x));
  if (pace == null) return null;
  // Short reps (1 km or less, 3 min or less) faster than threshold are 10k-pace or VO2 work: fast (v2's race-week
  // sharpeners, taper 10k-pace reps and the recovery fartlek).
  const short = /×\s*(?:(\d+) m\b|(0?\.\d+|1) km\b|([1-3]) min\b)/.exec(x);
  if (short && pace < zones.t - 2) return "fast";
  const d = [
    ["threshold", Math.abs(pace - zones.t)],
    ["mp", Math.abs(pace - zones.mp)],
    ["fast", Math.abs(pace - zones.v)],
  ] as const;
  return [...d].sort((a, b) => a[1] - b[1])[0][0];
};

describe("regression: key sessions, and the spec's session rules", () => {
  const { plan } = harryPlan();
  const zonesOf = (w: (typeof plan.weeks)[number]) => {
    const all = Object.values(w.sessions) as string[];
    const t = secs(/(?:Threshold[^:]*|min T): .*?at (\d):(\d\d)|Threshold: \d+ × [\d.]+ (?:km|min) at (\d):(\d\d)/.exec(all.join(" "))) ?? 0;
    return t;
  };
  void zonesOf;
  // The week's own paces, read from v2's own threshold, marathon-pace and VO2 columns (by date).
  const v2Zones = (start: string) =>
    start < "2026-12-21"
      ? { t: 230, mp: 241, v: 211 }
      : start < "2027-02-01"
        ? { t: 228, mp: 241, v: 208 }
        : start < "2027-05-31"
          ? { t: 226, mp: 240, v: 205 }
          : start < "2027-08-16"
            ? { t: 220, mp: 232, v: 200 }
            : { t: 217, mp: 227, v: 198 };

  // Differences accepted as the rule's version (17 Nov): cutback after 3 build weeks (4 and 11 Jan) and threshold not a
  // steady run (28 Jun). (1 Nov, threshold only: v2 updated to match.)
  const accepted = new Set(["2027-01-04", "2027-01-11", "2027-06-28"]);
  it("key-session types match v2 in at least 80% of weeks (all but the accepted differences)", () => {
    const off: string[] = [];
    for (const f of v2) {
      const w = plan.weeks.find((x) => x.start === f.start)!;
      const ours = (Object.values(w.sessions) as string[]).map(ourType).filter(Boolean).sort().join("+");
      const theirs = [f.s1, f.s2].map((x) => v2Type(x, v2Zones(f.start))).filter(Boolean).sort().join("+");
      if (ours !== theirs) off.push(`${f.start}: ${ours} vs ${theirs}`);
    }
    expect(off.length, off.join("; ")).toBeLessThanOrEqual(Math.floor(v2.length * 0.2));
    expect(off.filter((x) => !accepted.has(x.slice(0, 10))), "unexpected differences").toEqual([]);
  });

  const weeks = plan.weeks.filter((w) => w.start >= "2026-11-16" && w.start <= "2027-12-05");
  it("at most 2 key sessions a week; every session goes to the watch", () => {
    for (const w of weeks) {
      const keys = (Object.values(w.sessions) as string[]).filter((x) => ourType(x) && !/long run/.test(x));
      expect(keys.length, w.start).toBeLessThanOrEqual(2);
      for (const x of Object.values(w.sessions) as string[]) if (!/^Rest$/.test(x) && !/(10k|half|marathon|5k)\s*$/i.test(x)) expect(sessionToWorkout(x), x).not.toBeNull();
    }
  });

  it("VO2 max sessions: 15–21 min of hard running in reps of 2 min or more (30/15s and sharpeners aside)", () => {
    for (const w of weeks)
      for (const x of Object.values(w.sessions) as string[]) {
        const m = /VO2 max: (\d+) × ([\d.]+) (km|m|min) at (\d):(\d\d)/.exec(x);
        if (!m) continue;
        const pace = +m[4] * 60 + +m[5];
        const one = m[3] === "min" ? +m[2] * 60 : m[3] === "km" ? +m[2] * pace : (+m[2] / 1000) * pace;
        expect(one, x).toBeGreaterThanOrEqual(120);
        expect((+m[1] * one) / 60, x).toBeGreaterThanOrEqual(15);
        expect((+m[1] * one) / 60, x).toBeLessThanOrEqual(21);
      }
  });

  it("the week of a specific block's longest marathon-pace long run has threshold only", () => {
    for (const d of ["2027-04-19", "2027-11-01"]) {
      const w = weeks.find((x) => x.start === d)!;
      const keys = (Object.values(w.sessions) as string[]).filter((x) => ourType(x) && !/long run/.test(x));
      expect(keys.map(ourType), d).toEqual(["threshold"]);
      expect(w.sessions.sun, d).toMatch(/long run, last (2[2-5]) at MP/);
    }
  });

  it("the specific blocks' key long runs, as v2", () => {
    const want: Record<string, RegExp> = {
      "2027-04-12": /^30 km long run, last 16 at MP/,
      "2027-04-19": /^35 km long run, last 22 at MP/,
      "2027-05-10": /^30 km long run, last 14 at MP/,
      "2027-10-25": /^32 km long run/,
      "2027-11-01": /^36 km long run, last 25 at MP/,
      "2027-11-08": /^30 km long run$/,
      "2027-11-15": /^28 km long run, last 10 at MP/,
    };
    for (const [d, re] of Object.entries(want)) expect(weeks.find((x) => x.start === d)!.sessions.sun, d).toMatch(re);
  });

  it("heart-rate zones from threshold 188: threshold 180–188, marathon pace 171–179", () => {
    expect(plan.paces.find((z) => /^Threshold/.test(z.zone))!.hr).toBe("180–188");
    expect(plan.paces.find((z) => /^Marathon pace/.test(z.zone))!.hr).toBe("171–179");
  });

  it("an approximate race is on its nominal date, flagged", () => {
    const r = plan.races.find((x) => x.name === "Summer 10k")!;
    expect(r.date).toBe("2027-07-18");
    expect(r.approx).toBe(true);
    expect(weeks.find((x) => x.start === "2027-07-12")!.sessions.sun).toMatch(/Summer 10k/);
  });

  it("long runs: at most 33% of the week (rounded), 36 km", () => {
    for (const w of weeks) {
      const l = /(\d+) km (?:easy )?long run/.exec(w.sessions.sun ?? "");
      if (!l || !w.kmMin) continue;
      expect(+l[1], w.start).toBeLessThanOrEqual(36);
      expect(Math.round((+l[1] / w.kmMin) * 100), w.start).toBeLessThanOrEqual(33);
    }
  });

  it("phase emphasis: VO2 max blocks mostly VO2 max work, the base's key 1 threshold", () => {
    const of = (phase: string) => weeks.filter((w) => w.phase === phase).flatMap((w) => (Object.values(w.sessions) as string[]).map(ourType).filter(Boolean));
    const vo2 = of("VO2 max block");
    expect(vo2.filter((x) => x === "fast").length / vo2.length).toBeGreaterThanOrEqual(0.5);
    const base = weeks.filter((w) => w.phase === "Threshold base" && !/Antigel/.test(Object.values(w.sessions).join()));
    expect(base.filter((w) => /Threshold/.test(w.sessions.tue ?? "")).length / base.length).toBeGreaterThanOrEqual(0.6);
  });

  it("marathon pace: Edinburgh's in the spring, Valencia's goal pace only after Edinburgh", () => {
    const mpPaces = (from: string, to: string) =>
      weeks
        .filter((w) => w.start >= from && w.start < to)
        .flatMap((w) => Object.values(w.sessions) as string[])
        .map((x) => secs(/at MP (\d):(\d\d)/.exec(x)))
        .filter((x): x is number => x != null);
    expect(mpPaces("2026-11-16", "2027-05-31").every((x) => x >= 236)).toBe(true);
    expect(mpPaces("2027-08-16", "2027-12-06").some((x) => x <= 227)).toBe(true);
  });

  it("intensity: hard time ≤ 15% of the week; hard + moderate ≤ 25% before the specific blocks, ≤ 40% in them", () => {
    for (const w of weeks) {
      if (!w.kmMin || /taper|Race week|Recovery/i.test(w.phase)) continue;
      const all = Object.values(w.sessions) as string[];
      let hard = 0;
      let mod = 0;
      for (const x of all) {
        const r = /(\d+) × ([\d.]+) (km|m|min|s) at (\d):(\d\d)/.exec(x);
        const pace = r ? +r[4] * 60 + +r[5] : 0;
        const work = r ? +r[1] * (r[3] === "min" ? +r[2] * 60 : r[3] === "s" ? +r[2] : r[3] === "km" ? +r[2] * pace : (+r[2] / 1000) * pace) : 0;
        const sets = /(\d) sets of/.exec(x);
        const tem = /(\d+) min T at/.exec(x);
        if (/Marathon pace:|at MP|steady/.test(x)) {
          const k = /(\d+) km (?:steady|at MP)|last (\d+) at MP|(\d) × (\d+) km at MP/.exec(x);
          const km = k ? +(k[1] ?? k[2] ?? 0) || +(k[3] ?? 0) * +(k[4] ?? 0) : 0;
          mod += km * 235;
        } else if (tem) hard += +tem[1] * 60;
        else if (r && !/fartlek/.test(x)) hard += work * (sets ? +sets[1] : 1);
      }
      const total = w.kmMin * 300;
      const specific = /specific/.test(w.phase);
      expect(hard / total, `${w.start} hard`).toBeLessThanOrEqual(0.15);
      expect((hard + mod) / total, `${w.start} hard+moderate`).toBeLessThanOrEqual(specific ? 0.4 : 0.25);
    }
  });
});
