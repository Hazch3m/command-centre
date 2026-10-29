import { describe, expect, it } from "vitest";
import { parseDue, parseTask } from "./parse";

// Thursday 29 October 2026
const TODAY = "2026-10-29";

describe("parseDue", () => {
  it("handles words", () => {
    expect(parseDue("today", TODAY)).toBe("2026-10-29");
    expect(parseDue("tom", TODAY)).toBe("2026-10-30");
    expect(parseDue("nextweek", TODAY)).toBe("2026-11-02");
  });
  it("handles weekdays, including today", () => {
    expect(parseDue("fri", TODAY)).toBe("2026-10-30");
    expect(parseDue("thursday", TODAY)).toBe("2026-10-29");
    expect(parseDue("wed", TODAY)).toBe("2026-11-04");
    expect(parseDue("mo", TODAY)).toBeNull();
  });
  it("handles offsets and dates", () => {
    expect(parseDue("+3", TODAY)).toBe("2026-11-01");
    expect(parseDue("10d", TODAY)).toBe("2026-11-08");
    expect(parseDue("2027-05-30", TODAY)).toBe("2027-05-30");
    expect(parseDue("3/11", TODAY)).toBe("2026-11-03");
    expect(parseDue("5.1", TODAY)).toBe("2027-01-05"); // past this year → next year
    expect(parseDue("31/2", TODAY)).toBeNull();
    expect(parseDue("1/2/27", TODAY)).toBe("2027-02-01");
  });
});

describe("parseTask", () => {
  it("pulls out project, priority and date", () => {
    expect(parseTask("Email supervisor about chapter 2 #thesis !1 @fri", TODAY)).toEqual({
      title: "Email supervisor about chapter 2",
      project: "thesis",
      priority: 1,
      due: "2026-10-30",
    });
  });
  it("leaves unknown tokens in the title", () => {
    expect(parseTask("Book @someone !urgent", TODAY)).toEqual({ title: "Book @someone !urgent", project: null, priority: null, due: null });
  });
  it("turns dashes in projects into spaces", () => {
    expect(parseTask("Read paper #lit-review !low", TODAY).project).toBe("lit review");
  });
});
