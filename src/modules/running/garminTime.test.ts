import { describe, expect, it } from "vitest";
import { garminTimeAt } from "./readiness";

describe("Garmin's predicted time at any distance", () => {
  const v = { "5k": 1080, "10k": 2250, Half: 4980, Marathon: 10500 };
  it("gives Garmin's own times at its distances", () => {
    expect(garminTimeAt(v, 5000)).toBeCloseTo(1080);
    expect(garminTimeAt(v, 42195)).toBeCloseTo(10500);
  });
  it("follows Garmin's curve in between and beyond", () => {
    const t15 = garminTimeAt(v, 15000)!;
    expect(t15).toBeGreaterThan(2250 * 1.5);
    expect(t15).toBeLessThan(4980 * (15000 / 21097.5));
    expect(garminTimeAt(v, 3000)!).toBeLessThan(1080 * 0.6);
  });
});
