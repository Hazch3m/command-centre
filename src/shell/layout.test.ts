import { describe, expect, it } from "vitest";
import type { DashboardModule } from "../modules/types";
import { DEFAULTS, findSpot, LAYOUT_VERSION, orientationOf, resolveLayout, ROWS, type SavedLayout } from "./layout";

const mod = (id: string, x: number, y: number, w: number, h: number, extra: Partial<DashboardModule> = {}) =>
  ({ id, title: id, defaultPos: { x, y, w, h }, Card: () => null, ...extra }) as DashboardModule;

describe("resolveLayout", () => {
  const mods = [mod("running", 0, 0, 7, 9), mod("fitness", 7, 0, 5, 9), mod("clock", 0, 0, 12, 2, { defaultHidden: true }), mod("extra", 0, 4, 6, 10)];

  it("uses each orientation's own defaults until customised", () => {
    expect(resolveLayout(null, mods, "portrait").items.running).toEqual(DEFAULTS.portrait.running);
    expect(resolveLayout(null, mods, "landscape").items.running).toEqual(DEFAULTS.landscape.running);
    // Not in the default arrangement: starts in the hidden tray.
    expect(resolveLayout(null, mods, "landscape").hidden).toEqual(["clock", "extra"]);
  });

  it("keeps saved positions and leaves cards that aren't in the defaults hidden", () => {
    const saved: SavedLayout = { version: LAYOUT_VERSION, custom: true, items: { running: { x: 0, y: 0, w: 24, h: 6 } }, hidden: [] };
    const r = resolveLayout(saved, mods, "landscape");
    expect(r.items.running).toEqual({ x: 0, y: 0, w: 24, h: 6 });
    expect(r.items.fitness).toEqual(findSpot(DEFAULTS.landscape.fitness, [{ x: 0, y: 0, w: 24, h: 6 }], ROWS.landscape));
    expect(r.hidden).toContain("extra");
  });

  it("goes back to the defaults when the saved layout is from an older version", () => {
    const saved: SavedLayout = { version: 1, custom: true, items: { running: { x: 0, y: 0, w: 6, h: 4 } }, hidden: [] };
    const r = resolveLayout(saved, mods, "portrait");
    expect(r.custom).toBe(false);
    expect(r.items.running).toEqual(DEFAULTS.portrait.running);
  });

  it("finds no spot when nothing fits", () => {
    expect(findSpot({ x: 0, y: 0, w: 25, h: 1 }, [], 10)).toBeNull();
  });

  it("tells portrait from landscape", () => {
    expect(orientationOf(1152, 2048)).toBe("portrait");
    expect(orientationOf(1536, 864)).toBe("landscape");
  });
});
