import { describe, expect, it } from "vitest";
import { fitAroundDaysOff } from "./daysOff";
import type { ForecastDay } from "./forecast";

const day = (date: string, kind: ForecastDay["kind"], text: string, km: number | null, ran = false): ForecastDay =>
  ({ date, dow: "", text, kind, km, pace: null, strength: null, race: null, actualKm: ran ? km ?? 0 : 0, runs: ran ? [{ id: date } as never] : [] }) as ForecastDay;

// A week like this one: Mon done; Tue threshold; Wed easy; Thu key 2; Fri rest; Sat easy; Sun long.
const week = [
  day("2026-11-16", "easy", "10 km recovery + 20 min strength (calves, hamstrings, hips)", 10, true),
  day("2026-11-17", "key", "14 km with 3 km warm-up, Threshold: 4 × 2 km at 3:44–3:48, 2 min jog, 2 km cool-down", 14),
  day("2026-11-18", "easy", "13 km easy + 6 × 20 s strides + 20 min strength (calves, hamstrings, hips)", 13),
  day("2026-11-19", "key", "12 km with 3 km warm-up, VO2 max: 4 × 4 min at 3:25–3:29, 3 min jog, 2 km cool-down", 12),
  day("2026-11-20", "rest", "Rest", null),
  day("2026-11-21", "easy", "12 km easy + 6 × 20 s strides", 12),
  day("2026-11-22", "long", "24 km long run", 24),
];

describe("days off in a week", () => {
  it("can't run from Friday evening: long run to Friday, both sessions kept 48 h apart, easy km on Wednesday", () => {
    const r = fitAroundDaysOff(week, new Set(["2026-11-21", "2026-11-22"]), "2026-11-17");
    expect(r.changes.get("2026-11-20")).toBe("24 km long run");
    expect(r.changes.get("2026-11-21")).toBe("Rest");
    expect(r.changes.get("2026-11-22")).toBe("Rest");
    expect(r.changes.has("2026-11-17")).toBe(false); // Tuesday's session stays
    expect(r.changes.has("2026-11-19")).toBe(false); // Thursday's too, next to the long run (said)
    expect(r.notes.join(" ")).toMatch(/Thursday's session is next to the long run/);
    expect(r.changes.get("2026-11-18")).toMatch(/^22 km easy/); // 13 + 12 = 25, capped at 22
    expect(r.notes.join(" ")).toMatch(/3 km of easy running doesn't fit/);
    expect(r.changes.has("2026-11-16")).toBe(false); // already run
  });

  it("drops key 2 first when the sessions can't be 48 h apart", () => {
    const r = fitAroundDaysOff(week, new Set(["2026-11-19", "2026-11-21", "2026-11-22"]), "2026-11-17");
    // Days left: Tue, Wed, Fri. Long Fri, key 1 Tue; key 2 would be Wed (next to Tue): dropped.
    expect(r.changes.get("2026-11-20")).toBe("24 km long run");
    expect([...r.changes.values()].some((t) => /VO2 max/.test(t))).toBe(false);
    expect(r.notes.join(" ")).toMatch(/VO2 max: 4 × 4 min.* is left out/);
    expect(r.changes.get("2026-11-18")).toMatch(/^22 km easy/);
  });

  it("no days off: nothing changes", () => {
    expect(fitAroundDaysOff(week, new Set(), "2026-11-17").changes.size).toBe(0);
  });
});
