import { describe, expect, it } from "vitest";
import { fitArgs, readResult } from "./coach";
import { FAKE_TOOLS } from "../../core/fakeGarminCoach";

const tool = (n: string) => FAKE_TOOLS.find((t) => t.name === n)!;

describe("calling garmin-coach tools", () => {
  it("fits arguments to the tool's schema", () => {
    expect(fitArgs(tool("get_scheduled"), { start_date: "2026-11-09", end_date: "2026-11-15", extra: 1 })).toEqual({ start_date: "2026-11-09", end_date: "2026-11-15" });
    expect(fitArgs(tool("create_workout"), { name: "Easy", steps: [], date: undefined, description: "" })).toEqual({ name: "Easy", steps: [] });
    expect(() => fitArgs(tool("unschedule_workout"), {})).toThrow(/schedule_id/);
  });

  it("reads structured, list and text results", () => {
    expect(readResult({ content: [{ type: "text", text: "Easy (running)" }], structuredContent: { result: "Easy (running)" } }).data).toBe("Easy (running)");
    const list = readResult({ content: [{ type: "text", text: '{"date":"2026-11-09"}' }, { type: "text", text: '{"date":"2026-11-10"}' }] });
    expect(list.data).toEqual([{ date: "2026-11-09" }, { date: "2026-11-10" }]);
    expect(readResult({ content: [{ type: "text", text: '{"ok":true,"workoutId":5}' }] }).data).toEqual({ ok: true, workoutId: 5 });
  });
});
