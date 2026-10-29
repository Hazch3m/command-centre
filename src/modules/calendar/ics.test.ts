import { describe, expect, it } from "vitest";
import { icsName, parseIcs } from "./ics";

const ics = `BEGIN:VCALENDAR
X-WR-CALNAME:Harry
BEGIN:VEVENT
UID:a1
DTSTART;TZID=Europe/Zurich:20261026T090000
DTEND;TZID=Europe/Zurich:20261026T100000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE
EXDATE;TZID=Europe/Zurich:20261028T090000
SUMMARY:Lab meeting\\, weekly
LOCATION:Bldg 40
BEGIN:VALARM
TRIGGER:-PT10M
SUMMARY:alarm
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:a1
RECURRENCE-ID;TZID=Europe/Zurich:20261102T090000
DTSTART;TZID=Europe/Zurich:20261102T140000
DTEND;TZID=Europe/Zurich:20261102T150000
SUMMARY:Lab meeting (moved)
END:VEVENT
BEGIN:VEVENT
UID:b
DTSTART;VALUE=DATE:20261103
DTEND;VALUE=DATE:20261106
SUMMARY:Conference
END:VEVENT
BEGIN:VEVENT
UID:c
DTSTART:20261030T180000Z
DTEND:20261030T190000Z
SUMMARY:Call
END:VEVENT
BEGIN:VEVENT
UID:d
DTSTART;TZID=Europe/Zurich:20260105T080000
DURATION:PT30M
RRULE:FREQ=MONTHLY;BYDAY=1TH;COUNT=20
SUMMARY:First Thursday
END:VEVENT
END:VCALENDAR`;

describe("iCal feeds", () => {
  const evs = parseIcs(ics, Date.parse("2026-10-26T00:00:00+01:00"), Date.parse("2026-11-09T00:00:00+01:00"));
  it("expands weekly repeats in the event's time zone, skipping exceptions", () => {
    const lab = evs.filter((e) => e.summary.startsWith("Lab meeting"));
    expect(lab.map((e) => e.start)).toEqual(["2026-10-26T08:00:00.000Z", "2026-11-02T13:00:00.000Z", "2026-11-04T08:00:00.000Z"]);
    expect(lab[1].summary).toBe("Lab meeting (moved)");
    expect(lab[0].summary).toBe("Lab meeting, weekly");
    expect(lab[0].location).toBe("Bldg 40");
  });
  it("reads all-day, UTC and monthly-by-weekday events", () => {
    expect(evs.find((e) => e.summary === "Conference")).toMatchObject({ allDay: true, start: "2026-11-03", end: "2026-11-06" });
    expect(evs.find((e) => e.summary === "Call")?.start).toBe("2026-10-30T18:00:00.000Z");
    const first = evs.filter((e) => e.summary === "First Thursday");
    expect(first.map((e) => e.start)).toEqual(["2026-11-05T07:00:00.000Z"]);
    expect(first[0].end).toBe("2026-11-05T07:30:00.000Z");
  });
  it("ignores alarms inside events and reads the calendar name", () => {
    expect(evs.some((e) => e.summary === "alarm")).toBe(false);
    expect(icsName(ics)).toBe("Harry");
  });
});
