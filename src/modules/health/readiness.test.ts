import { describe, expect, it } from "vitest";
import { addDays } from "../../core/time";
import type { HealthDay } from "./data";
import { ownReadiness } from "./readiness";

const day = (date: string, f: Partial<HealthDay>): HealthDay => ({ date, ...f }) as HealthDay;
const today = "2026-10-30";
const base = Array.from({ length: 30 }, (_, i) => day(addDays(today, i - 30), { hrv: 60 + (i % 3) - 1, rhr: 45 + (i % 2), sleep_secs: 7.5 * 3600 }));
const load = Array.from({ length: 28 }, (_, i) => ({ date: addDays(today, i - 28), load: 70 }));

describe("own readiness", () => {
  it("is high after a normal night with steady training", () => {
    const r = ownReadiness([...base, day(today, { hrv: 62, rhr: 45, sleep_secs: 8 * 3600 })], today, load)!;
    expect(r.score).toBeGreaterThanOrEqual(75);
    expect(r.parts.map((p) => p.name)).toEqual(["HRV", "Sleep", "Resting HR", "Training load"]);
  });
  it("drops with low HRV, short sleep and raised resting HR", () => {
    const r = ownReadiness([...base, day(today, { hrv: 48, rhr: 51, sleep_secs: 5.2 * 3600 })], today, load)!;
    expect(r.score).toBeLessThan(50);
    expect(r.limiter).not.toBeNull();
  });
  it("drops after a big jump in load", () => {
    const heavy = [...load, ...Array.from({ length: 7 }, (_, i) => ({ date: addDays(today, i - 7), load: 160 }))];
    const calm = ownReadiness([...base, day(today, { hrv: 60, rhr: 45, sleep_secs: 7.5 * 3600 })], today, load)!;
    const hard = ownReadiness([...base, day(today, { hrv: 60, rhr: 45, sleep_secs: 7.5 * 3600 })], today, heavy)!;
    expect(hard.score).toBeLessThan(calm.score - 10);
  });
  it("needs last night's data", () => {
    expect(ownReadiness(base, today, load)).toBeNull();
  });
});
