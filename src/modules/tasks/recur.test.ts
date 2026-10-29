import { describe, expect, it } from "vitest";
import { describeRecur, nextOccurrence, parseRecurToken } from "./recur";

// 2026-10-29 is a Thursday
describe("parseRecurToken", () => {
  it("parses words, intervals and weekday lists", () => {
    expect(parseRecurToken("daily")).toBe("d:1");
    expect(parseRecurToken("weekdays")).toBe("wd");
    expect(parseRecurToken("weekly")).toBe("w:1:");
    expect(parseRecurToken("2w")).toBe("w:2:");
    expect(parseRecurToken("3d")).toBe("d:3");
    expect(parseRecurToken("monthly")).toBe("m:1");
    expect(parseRecurToken("mon,thu")).toBe("w:1:1,4");
    expect(parseRecurToken("friday")).toBe("w:1:5");
    expect(parseRecurToken("soon")).toBeNull();
  });
  it("describes rules", () => {
    expect(describeRecur("w:1:1,4")).toBe("Weekly on Mon, Thu");
    expect(describeRecur("w:2:")).toBe("Fortnightly");
    expect(describeRecur("d:3")).toBe("Every 3 days");
  });
});

describe("nextOccurrence", () => {
  it("steps days, weekdays and months", () => {
    expect(nextOccurrence("d:1", "2026-10-29")).toBe("2026-10-30");
    expect(nextOccurrence("wd", "2026-10-30")).toBe("2026-11-02"); // Fri → Mon
    expect(nextOccurrence("m:1", "2026-01-31")).toBe("2026-02-28");
    expect(nextOccurrence("m:1", "2026-10-29")).toBe("2026-11-29");
  });
  it("handles weekly rules with and without days", () => {
    expect(nextOccurrence("w:1:", "2026-10-29")).toBe("2026-11-05");
    expect(nextOccurrence("w:2:", "2026-10-29")).toBe("2026-11-12");
    expect(nextOccurrence("w:1:1,4", "2026-10-29")).toBe("2026-11-02"); // Thu → Mon
    expect(nextOccurrence("w:1:1,4", "2026-11-02")).toBe("2026-11-05"); // Mon → Thu
    expect(nextOccurrence("w:2:1,4", "2026-10-29")).toBe("2026-11-09"); // Thu → Mon of week after next
  });
});
