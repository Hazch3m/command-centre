import { describe, expect, it } from "vitest";
import { scalePaces } from "./planRefresh";

describe("moving a plan's paces", () => {
  it("scales paces but not durations", () => {
    expect(scalePaces("9 km easy, 3 km at 4:12–4:18", 0.92)).toBe("9 km easy, 3 km at 3:52–3:57");
    expect(scalePaces("4 × 1.2 km at 3:24–3:28, 2:30 jog", 1)).toBe("4 × 1.2 km at 3:24–3:28, 2:30 jog");
    expect(scalePaces("4 × 1.2 km at 3:24–3:28, 2:30 jog", 0.95)).toContain("2:30 jog");
  });
});
