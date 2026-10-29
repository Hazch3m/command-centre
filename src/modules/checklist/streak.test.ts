import { describe, expect, it } from "vitest";
import { streaks } from "./streak";

describe("streaks", () => {
  const today = "2026-11-02"; // across a month boundary
  it("counts back from today when done today", () => {
    expect(streaks(["2026-10-31", "2026-11-01", "2026-11-02"], today)).toEqual({ current: 3, best: 3, alive: true });
  });
  it("stays alive until the day is over", () => {
    expect(streaks(["2026-10-31", "2026-11-01"], today).current).toBe(2);
  });
  it("breaks after a missed day and remembers the best", () => {
    expect(streaks(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-11-02"], today)).toEqual({ current: 1, best: 4, alive: true });
    expect(streaks(["2026-10-30"], today)).toEqual({ current: 0, best: 1, alive: false });
  });
  it("handles nothing", () => {
    expect(streaks([], today)).toEqual({ current: 0, best: 0, alive: false });
  });
});
