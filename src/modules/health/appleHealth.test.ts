import { describe, expect, it } from "vitest";
import { buildFromGarmin } from "../running/garminRuns";
import { hkDetailsAsGarmin, hkId, hkRow } from "./appleHealth";
import { phoneMayWrite } from "../../core/sync";

describe("Apple Health runs", () => {
  const t0 = Date.parse("2026-11-08T09:00:00");
  it("a workout becomes a run row with an hk id", () => {
    const r = hkRow({ uuid: "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9", start: t0, end: t0 + 1900_000, duration: 1800, distance: 6000, avgHr: 151.4, maxHr: 170 });
    expect(r.id).toBe("hk0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    expect(r.name).toBe("Morning Run");
    expect(r.moving_time).toBe(1800);
    expect(r.avg_hr).toBe(151);
  });
  it("route and heart rate become km splits and a map", () => {
    // 5 km straight north at 5:00/km, a point every 10 s.
    const route: number[][] = [];
    const hr: number[][] = [];
    for (let s = 0; s <= 1500; s += 10) {
      route.push([t0 + s * 1000, 46.0 + (s * 3.333) / 111_195, 6.6, 400, 3.333]);
      hr.push([t0 + s * 1000, 140 + s / 100]);
    }
    const b = buildFromGarmin(hkDetailsAsGarmin({ hr, dist: [], route }), null);
    expect(b.detail.splits.length).toBe(5);
    expect(b.detail.splits[0].moving_time).toBeGreaterThan(290);
    expect(b.detail.splits[0].moving_time).toBeLessThan(310);
    expect(b.detail.splits[4].hr).toBeGreaterThan(b.detail.splits[0].hr!);
    expect(b.polyline).toBeTruthy();
  });
  it("the phone may write its own Health runs, never other runs or deletes", () => {
    const id = hkId("0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9");
    expect(phoneMayWrite("INSERT INTO strava_activities (id, date) VALUES (?, ?)", [id, "2026-11-08"])).toBe(true);
    expect(phoneMayWrite("INSERT INTO strava_activities (id, date) VALUES (?, ?)", ["g123", "2026-11-08"])).toBe(false);
    expect(phoneMayWrite("DELETE FROM strava_activities WHERE id = ?", [id])).toBe(false);
    expect(phoneMayWrite("UPDATE strava_activities SET polyline = ? WHERE id = ?", ["abc", id])).toBe(true);
  });
});
