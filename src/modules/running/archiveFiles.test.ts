import { describe, expect, it } from "vitest";
import { isRunType, parseActivitiesCsv, parseFit, parseGpx, parseStravaDate, parseTcx, zipEntries, zipRead } from "./archiveFiles";
import { archiveRow, localAt, sxId } from "./stravaArchive";
import { phoneMayWrite } from "../../core/sync";

describe("Strava archive: activities.csv", () => {
  // The real header repeats Distance (km, then metres) and Elapsed Time; quoted fields hold commas.
  const csv = [
    "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,Average Speed,Elevation Gain,Average Heart Rate",
    '12345678901,"Nov 8, 2026, 7:12:45 AM",Morning Run,Run,"Easy, with strides",3010,8.52,171.0,40,false,,Pegasus,activities/12345678901.fit.gz,,,3010,2950,8523.4,4.1,2.89,64,148.2',
    '12345678902,"Nov 9, 2026, 6:00:00 PM",Evening Ride,Ride,,3600,30.1,,,false,,,activities/12345678902.gpx,,,3600,3500,30100,10,8,200,',
    '12345678903,"Oct 1, 2026, 12:05:00 PM",Lunch Run,Virtual Run,,1800,5.0,,,false,,,,,,1800,1790,5000,3,2.8,0,',
  ].join("\r\n");

  it("reads runs with the metres column, moving time, heart rate and file", () => {
    const a = parseActivitiesCsv(csv);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ id: "12345678901", name: "Morning Run", type: "Run", elapsed: 3010, moving: 2950, distance: 8523.4, elevation: 64, avgHr: 148.2, maxHr: 171, file: "activities/12345678901.fit.gz" });
    expect(a[0].start).toBe(Date.UTC(2026, 10, 8, 7, 12, 45));
    expect(a[1].start).toBe(Date.UTC(2026, 10, 9, 18, 0, 0));
    expect(a.filter((x) => isRunType(x.type)).map((x) => x.id)).toEqual(["12345678901", "12345678903"]);
    expect(a[2].file).toBeNull();
  });

  it("reads 12-hour times around noon and midnight, and ISO dates", () => {
    expect(parseStravaDate("Jan 2, 2025, 12:30:00 AM")).toBe(Date.UTC(2025, 0, 2, 0, 30, 0));
    expect(parseStravaDate("Jan 2, 2025, 12:30:00 PM")).toBe(Date.UTC(2025, 0, 2, 12, 30, 0));
    expect(parseStravaDate("2025-01-02 07:15:00")).toBe(Date.UTC(2025, 0, 2, 7, 15, 0));
  });

  it("makes a run row in the run's own time zone", () => {
    const [a] = parseActivitiesCsv(csv);
    const row = archiveRow(a, { route: [], hr: [], dist: [], tzOffsetMin: 60 });
    expect(row.id).toBe(sxId("12345678901"));
    expect(row.start_local).toBe("2026-11-08T08:12:45");
    expect(row.date).toBe("2026-11-08");
    expect(row.moving_time).toBe(2950);
    expect(row.avg_hr).toBe(148);
    expect(localAt(Date.UTC(2026, 0, 1, 23, 30), -300)).toBe("2026-01-01T18:30:00");
  });

  it("lets the phone store archive runs (and nothing else new)", () => {
    expect(phoneMayWrite("INSERT INTO strava_activities (id, date) VALUES (?, ?)", ["sx12345678901", "2026-11-08"])).toBe(true);
    expect(phoneMayWrite("INSERT OR REPLACE INTO strava_full (id, json, fetched_at) VALUES (?, ?, ?)", ["sx12345678901", "{}", "x"])).toBe(true);
    expect(phoneMayWrite("INSERT INTO strava_activities (id, date) VALUES (?, ?)", ["12345678901", "2026-11-08"])).toBe(false);
    expect(phoneMayWrite("DELETE FROM strava_activities WHERE id = ?", ["sx1"])).toBe(false);
  });
});

describe("Strava archive: activity files", () => {
  it("reads a GPX track with heart rate", () => {
    const gpx = `<?xml version="1.0"?><gpx><trk><trkseg>
      <trkpt lat="46.2" lon="6.1"><ele>375.2</ele><time>2026-11-08T07:12:45Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
      <trkpt lat="46.201" lon="6.1"><ele>376</ele><time>2026-11-08T07:13:15Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>131</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
    </trkseg></trk></gpx>`;
    const t = parseGpx(gpx);
    expect(t.route).toHaveLength(2);
    expect(t.route[0].slice(0, 4)).toEqual([Date.UTC(2026, 10, 8, 7, 12, 45), 46.2, 6.1, 375.2]);
    expect(t.hr.map((h) => h[1])).toEqual([120, 131]);
  });

  it("reads a TCX treadmill run (distance, no GPS)", () => {
    const tcx = `<TrainingCenterDatabase><Activities><Activity><Lap><Track>
      <Trackpoint><Time>2026-11-08T07:00:00Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>110</Value></HeartRateBpm></Trackpoint>
      <Trackpoint><Time>2026-11-08T07:01:00Z</Time><DistanceMeters>180.5</DistanceMeters><HeartRateBpm><Value>140</Value></HeartRateBpm></Trackpoint>
    </Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const t = parseTcx(tcx);
    expect(t.route).toHaveLength(0);
    expect(t.dist.map((d) => d[1])).toEqual([0, 180.5]);
    expect(t.hr).toHaveLength(2);
  });

  it("reads FIT records, compressed timestamps and the time zone", () => {
    // A tiny FIT file: a record definition, two records (one with a compressed timestamp), an activity.
    const bytes: number[] = [];
    const u8 = (x: number) => bytes.push(x & 0xff);
    const u16 = (x: number) => (u8(x), u8(x >> 8));
    const u32 = (x: number) => (u16(x), u16(x >>> 16));
    const i32 = (x: number) => u32(x >>> 0);
    const ts0 = 1_100_000_000; // seconds since 31 Dec 1989
    // definition: local 0 → record (20): timestamp, lat, lon, heart rate, distance
    u8(0x40); u8(0); u8(0); u16(20); u8(5);
    u8(253); u8(4); u8(0x86);
    u8(0); u8(4); u8(0x85);
    u8(1); u8(4); u8(0x85);
    u8(3); u8(1); u8(0x02);
    u8(5); u8(4); u8(0x86);
    const semi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
    u8(0x00); u32(ts0); i32(semi(46.2)); i32(semi(6.1)); u8(120); u32(0);
    // definition: local 1 → record without timestamp (for compressed headers)
    u8(0x41); u8(0); u8(0); u16(20); u8(4);
    u8(0); u8(4); u8(0x85);
    u8(1); u8(4); u8(0x85);
    u8(3); u8(1); u8(0x02);
    u8(5); u8(4); u8(0x86);
    // compressed timestamp header: local 1, +5 s
    u8(0x80 | (1 << 5) | ((ts0 + 5) & 0x1f)); i32(semi(46.2005)); i32(semi(6.1)); u8(130); u32(1500);
    // definition: local 2 → activity (34): timestamp, local_timestamp
    u8(0x42); u8(0); u8(0); u16(34); u8(2);
    u8(253); u8(4); u8(0x86);
    u8(5); u8(4); u8(0x86);
    u8(0x02); u32(ts0 + 5); u32(ts0 + 5 + 3600);
    const head = [14, 0x10, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0];
    const size = bytes.length;
    head[4] = size & 0xff; head[5] = (size >> 8) & 0xff;
    const buf = new Uint8Array([...head, ...bytes, 0, 0]);
    const t = parseFit(buf);
    const epoch = Date.UTC(1989, 11, 31);
    expect(t.route).toHaveLength(2);
    expect(t.route[0][0]).toBe(epoch + ts0 * 1000);
    expect(t.route[1][0]).toBe(epoch + (ts0 + 5) * 1000);
    expect(t.route[0][1]).toBeCloseTo(46.2, 5);
    expect(t.hr.map((h) => h[1])).toEqual([120, 130]);
    expect(t.tzOffsetMin).toBe(60);
  });

  it("reads a zip's table of contents and a stored entry", async () => {
    const enc = new TextEncoder();
    const name = enc.encode("activities.csv");
    const data = enc.encode("Activity ID,Activity Date\n1,\"Jan 1, 2026, 7:00:00 AM\"\n");
    const b: number[] = [];
    const u16 = (x: number) => b.push(x & 0xff, (x >> 8) & 0xff);
    const u32 = (x: number) => (u16(x & 0xffff), u16(x >>> 16));
    // local header
    u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(data.length); u32(data.length); u16(name.length); u16(0);
    b.push(...name, ...data);
    const cd = b.length;
    u32(0x02014b50); u16(20); u16(20); u16(0); u16(0); u16(0); u16(0); u32(0); u32(data.length); u32(data.length); u16(name.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(0);
    b.push(...name);
    const cdSize = b.length - cd;
    u32(0x06054b50); u16(0); u16(0); u16(1); u16(1); u32(cdSize); u32(cd); u16(0);
    const blob = new Blob([new Uint8Array(b)]);
    const entries = await zipEntries(blob);
    expect(entries.map((e) => e.name)).toEqual(["activities.csv"]);
    expect(new TextDecoder().decode(await zipRead(blob, entries[0]))).toContain("Activity ID");
  });
});
