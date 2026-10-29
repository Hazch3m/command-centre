import { describe, expect, it } from "vitest";
import { parseBodyBattery, parseHrv, parsePredictions, parseReadiness, parseRhr, parseSleep, parseVo2, pickNum, type Patch } from "./data";

describe("reading Garmin's replies", () => {
  it("finds numbers a few levels down", () => {
    expect(pickNum({ a: { b: { vo2MaxPreciseValue: 61.2 } } }, /vo2MaxPreciseValue/)).toBe(61.2);
    expect(pickNum({ a: 1 }, /b/)).toBeNull();
  });
  it("parses each metric", () => {
    const p: Patch = new Map();
    parseVo2([{ generic: { calendarDate: "2026-10-28", vo2MaxPreciseValue: 61.2, vo2MaxValue: 61 }, cycling: null }], p);
    parseHrv({ hrvSummaries: [{ calendarDate: "2026-10-28", weeklyAvg: 71, lastNightAvg: 68, status: "BALANCED", baseline: { balancedLow: 60, balancedUpper: 80 } }] }, p);
    parseRhr({ allMetrics: { metricsMap: { WELLNESS_RESTING_HEART_RATE: [{ calendarDate: "2026-10-28", value: 44 }] } } }, p);
    parseSleep({ individualStats: [{ calendarDate: "2026-10-28", values: { totalSleepTimeInSeconds: 27000, sleepScore: 82 } }] }, p);
    parseBodyBattery([{ date: "2026-10-28", bodyBatteryValuesArray: [[1, 30], [2, 85], [3, 60]] }], p, "2026-10-28");
    parseReadiness(
      [
        { calendarDate: "2026-10-28", timestampLocal: "2026-10-28T18:00", score: 40, level: "MODERATE" },
        { calendarDate: "2026-10-28", timestampLocal: "2026-10-28T07:00", score: 72, level: "HIGH" },
      ],
      p,
    );
    parsePredictions({ calendarDate: "2026-10-28", time5K: 1050, time10K: 2228, timeHalfMarathon: 4978, timeMarathon: 10670 }, p, "2026-10-29");
    expect(p.get("2026-10-28")).toEqual({
      vo2: 61.2,
      hrv: 68,
      hrv_week: 71,
      hrv_status: "BALANCED",
      hrv_low: 60,
      hrv_high: 80,
      rhr: 44,
      sleep_secs: 27000,
      sleep_score: 82,
      bb_high: 85,
      bb_low: 30,
      bb_now: 60,
      readiness: 40,
      readiness_level: "MODERATE",
      pred_5k: 1050,
      pred_10k: 2228,
      pred_half: 4978,
      pred_marathon: 10670,
    });
  });
  it("ignores empty or odd replies", () => {
    const p: Patch = new Map();
    parseVo2(null, p);
    parseHrv({}, p);
    parseSleep({ individualStats: [{ calendarDate: "2026-10-28" }] }, p);
    expect(p.size).toBe(0);
  });
});
