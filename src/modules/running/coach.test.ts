import { describe, expect, it } from "vitest";
import { goalSeconds, recoveryOf, trackOf } from "./coach";
import type { HealthDay } from "../health/data";

const day = (date: string, over: Partial<HealthDay>): HealthDay =>
  ({ date, vo2: null, hrv: null, hrv_week: null, hrv_status: null, hrv_low: null, hrv_high: null, rhr: null, sleep_secs: null, sleep_score: null, bb_high: null, bb_low: null, bb_now: null, readiness: null, readiness_level: null, readiness_note: null, sleep_end: null, pred_5k: null, pred_10k: null, pred_half: null, pred_marathon: null, ...over }) as HealthDay;

describe("coach", () => {
  it("reads goal times", () => {
    expect(goalSeconds("2:48–2:52", 42.2)).toBe(2 * 3600 + 52 * 60);
    expect(goalSeconds("Sub-2:45", 42.2)).toBe(2 * 3600 + 45 * 60);
    expect(goalSeconds("19:30", 5)).toBe(19 * 60 + 30);
    expect(goalSeconds("1:25:00", 21.1)).toBe(5100);
    expect(goalSeconds("", 10)).toBeNull();
  });
  it("judges the goal", () => {
    const base = { raceName: "Race", km: 42.2, target: "2:50", daysTo: 150, completion: 1 };
    expect(trackOf({ ...base, now: 10000, monthAgo: 10100 }).verdict).toBe("Ahead of goal");
    expect(trackOf({ ...base, now: 10400, monthAgo: 10600 }).verdict).toBe("On track");
    expect(trackOf({ ...base, now: 10400, monthAgo: 10400 }).verdict).toBe("Slightly behind");
    expect(trackOf({ ...base, now: 11200, monthAgo: 11200, completion: 0.6 }).fix).toMatch(/60%/);
    expect(trackOf({ ...base, now: null, monthAgo: null }).tone).toBe("info");
  });
  it("flags poor recovery from two signals", () => {
    const rows = Array.from({ length: 14 }, (_, i) => day(`2026-11-${String(i + 1).padStart(2, "0")}`, { hrv: 70, hrv_low: 60, rhr: 45, sleep_secs: 7.5 * 3600 }));
    expect(recoveryOf(rows, "2026-11-14").level).toBe("good");
    rows[12] = day("2026-11-13", { hrv: 50, hrv_low: 60, rhr: 45, sleep_secs: 7 * 3600 });
    rows[13] = day("2026-11-14", { hrv: 52, hrv_low: 60, rhr: 52, sleep_secs: 5 * 3600 });
    const r = recoveryOf(rows, "2026-11-14");
    expect(r.level).toBe("poor");
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
    expect(recoveryOf([], "2026-11-14").level).toBe("unknown");
  });
});
