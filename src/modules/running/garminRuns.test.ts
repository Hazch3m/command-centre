import { describe, expect, it } from "vitest";
import { decodePolyline } from "./route";
import { bestEfforts, buildFromGarmin, encodePolyline, garminRow, garminStreams, kmSplits } from "./garminRuns";

/** A 10.5 km run: 4:00/km for the first 5 km, then 4:20/km, one sample every 5 s. */
function sampleRun() {
  const rows: { metrics: (number | null)[] }[] = [];
  let d = 0;
  for (let t = 0; d < 10500; t += 5) {
    rows.push({ metrics: [1_700_000_000_000 + t * 1000, d, 150 + Math.min(20, t / 120), 1000 / (d < 5000 ? 240 : 260), 400 + Math.sin(t / 200) * 10, 88] });
    d += (5 * 1000) / (d < 5000 ? 240 : 260);
  }
  return {
    metricDescriptors: ["directTimestamp", "sumDistance", "directHeartRate", "directSpeed", "directElevation", "directRunCadence"].map((key, metricsIndex) => ({ key, metricsIndex })),
    activityDetailMetrics: rows,
    geoPolylineDTO: { polyline: [{ lat: 46.2, lon: 6.14 }, { lat: 46.201, lon: 6.142 }, { lat: 46.2032, lon: 6.1451 }] },
  };
}

describe("runs from Garmin", () => {
  it("stores a Garmin activity like a Strava run", () => {
    const r = garminRow({
      activityId: 19876543210,
      activityName: "Evening Run",
      startTimeLocal: "2026-11-03 18:30:00",
      startTimeGMT: "2026-11-03 17:30:00",
      activityType: { typeKey: "running" },
      eventType: { typeKey: "race" },
      distance: 10020,
      duration: 2460,
      movingDuration: 2440,
      elapsedDuration: 2470,
      averageHR: 162,
      maxHR: 181,
      elevationGain: 35,
    });
    expect(r).toMatchObject({ id: "g19876543210", date: "2026-11-03", start_local: "2026-11-03T18:30:00", sport: "Run", moving_time: 2440, elapsed_time: 2470, workout_type: 1, has_hr: 1 });
    expect(r.start_epoch).toBe(Date.UTC(2026, 10, 3, 17, 30) / 1000);
  });

  it("works out best efforts from the samples", () => {
    const st = garminStreams(sampleRun())!;
    const be = new Map(bestEfforts(st).map((b) => [b.name, b.time]));
    expect(Math.abs(be.get("1K")! - 240)).toBeLessThanOrEqual(5);
    expect(Math.abs(be.get("5K")! - 1200)).toBeLessThanOrEqual(6);
    expect(Math.abs(be.get("10K")! - (1200 + 1300))).toBeLessThanOrEqual(8);
    expect(be.has("15K")).toBe(false);
  });

  it("splits by kilometre, with heart rate and pace", () => {
    const sp = kmSplits(garminStreams(sampleRun())!);
    expect(sp.length).toBe(11);
    expect(Math.abs(sp[0].moving_time - 240)).toBeLessThanOrEqual(5);
    expect(Math.abs(sp[7].moving_time - 260)).toBeLessThanOrEqual(5);
    expect(sp[0].hr).toBeGreaterThan(149);
    expect(sp[10].distance).toBeLessThan(600);
  });

  it("draws the route", () => {
    const pts = sampleRun().geoPolylineDTO.polyline;
    const back = decodePolyline(encodePolyline(pts));
    expect(back).toHaveLength(3);
    expect(Math.abs(back[2][0] - 46.2032)).toBeLessThan(1e-4);
    expect(Math.abs(back[2][1] - 6.1451)).toBeLessThan(1e-4);
  });

  it("builds laps, charts and details together", () => {
    const b = buildFromGarmin(sampleRun(), { lapDTOs: [{ distance: 5000, duration: 1200, movingDuration: 1200, averageSpeed: 4.17, averageHR: 155, averageRunCadence: 176 }, { distance: 5500, duration: 1430, averageSpeed: 3.85 }] });
    expect(b.full.laps).toHaveLength(2);
    expect(b.full.laps[0].cadence).toBe(176);
    expect(b.full.streams!.distance!.length).toBeGreaterThan(100);
    expect(b.detail.laps![1].moving_time).toBe(1430);
    expect(b.polyline).toBeTruthy();
  });
});
