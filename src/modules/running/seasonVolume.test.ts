import { describe, expect, it } from "vitest";
import { segmentSeason } from "./season";
import { focusWeeks, seasonVolumes } from "./seasonVolume";
import v2 from "./fixtures/valencia-v2.json";

// Harry's season against the "Valencia plan v2" tab (fixtures/valencia-v2.json: its week-by-week table).
const others = [
  { name: "5k", date: "2026-12-19", km: 5 },
  { name: "Antigel 10k", date: "2027-02-07", km: 10 },
  { name: "Aix 10k", date: "2027-03-28", km: 10 },
  { name: "Killarney half", date: "2027-05-08", km: 21.1 },
  { name: "Summer 10k", date: "2027-07-18", km: 10, uncertainty: 7 },
  { name: "Lausanne half", date: "2027-10-24", km: 21.1 },
];
const season = segmentSeason({ start: "2026-11-16", primary: { name: "Valencia marathon", date: "2027-12-05" }, secondaries: [{ name: "Edinburgh marathon", date: "2027-05-30" }], others, lastMarathon: "2026-10-25" });
const vol = seasonVolumes({ start: "2026-11-16", weeks: v2.length, season, primary: "Valencia marathon", startKm: 64, cap: 120, races: others.map((r) => ({ date: r.date, km: r.km })) });

describe("season volume", () => {
  it("weekly km within ±10% of v2 in at least 90% of weeks", () => {
    const off = vol.filter((w, i) => Math.abs(w.km - v2[i].km) / v2[i].km > 0.1).map((w) => w.monday);
    expect(off.length, `weeks off: ${off.join(", ")}`).toBeLessThanOrEqual(Math.floor(v2.length * 0.1));
  });

  it("focus weeks: 22 Feb and 15 Mar, 5 Jul and 26 Jul", () => {
    const f = focusWeeks(season, new Set(["2026-12-14", "2027-02-01", "2027-03-22", "2027-05-03", "2027-07-12", "2027-10-18"]));
    expect([...f].sort()).toEqual(["2027-02-22", "2027-03-15", "2027-07-05", "2027-07-26"]);
  });

  it("keeps the spec's volume rules", () => {
    let lastFull = 64;
    let run = 0;
    let ramping = false;
    for (const w of vol) {
      if (w.type === "build") {
        // At most min(15 km, 15%) above the last full week; ramping back after recovery, up to 25%.
        const lim = ramping ? lastFull * 0.25 : Math.min(15, lastFull * 0.15);
        expect(w.km, w.monday).toBeLessThanOrEqual(Math.round(lastFull + lim) + 1);
        lastFull = w.km;
        run++;
      } else if (w.type === "start") lastFull = w.km;
      else if (w.type === "recovery") {
        lastFull = w.km;
        ramping = true;
        run = 0;
      } else run = 0;
      if (ramping && w.type === "build" && w.km >= 0.9 * 108) ramping = false;
      expect(run, `build weeks in a row at ${w.monday}`).toBeLessThanOrEqual(4);
      if (w.type === "build" || w.type === "cut" || w.type === "post" || w.type === "start") expect(w.km, w.monday).toBeGreaterThanOrEqual(50);
      expect(w.km).toBeLessThanOrEqual(120);
    }
    // Spring (to Edinburgh) ≤ 112 (0.93 × cap); autumn ≤ 120.
    expect(Math.max(...vol.filter((w) => w.monday < "2027-05-30").map((w) => w.km))).toBeLessThanOrEqual(112);
    // Focus weeks are never lighter weeks.
    expect(vol.filter((w) => w.focus).every((w) => w.type === "build" || w.type === "post")).toBe(true);
  });
});
