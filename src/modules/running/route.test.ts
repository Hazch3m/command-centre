import { describe, expect, it } from "vitest";
import { decodePolyline } from "./route";

describe("decodePolyline", () => {
  it("decodes Google's reference example", () => {
    expect(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
  it("decodes a real Strava route near Saint-Genis-Pouilly", () => {
    const pts = decodePolyline("{yfyGecyc@h@^tAfA`A^v@r@^Vf@Tn@d@");
    expect(pts[0][0]).toBeCloseTo(46.24, 1);
    expect(pts[0][1]).toBeCloseTo(6.03, 1);
  });
});
