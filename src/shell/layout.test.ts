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

describe("cards pushed off the screen", () => {
  it("come back into free space, or are hidden when there's none", async () => {
    const { fitToScreen } = await import("./layout");
    const items = { a: { x: 0, y: 0, w: 24, h: 10 }, b: { x: 0, y: 22, w: 12, h: 6 }, c: { x: 0, y: 10, w: 24, h: 14 } };
    const r = fitToScreen(items, 24);
    expect(r.items.a).toEqual(items.a);
    expect(r.hidden).toEqual(["b"]);
    const r2 = fitToScreen({ a: { x: 0, y: 0, w: 24, h: 10 }, b: { x: 0, y: 22, w: 12, h: 6 } }, 24);
    expect(r2.moved).toEqual(["b"]);
    expect(r2.items.b.y + r2.items.b.h).toBeLessThanOrEqual(24);
  });
});

describe("filling gaps", () => {
  it("grows cards into empty space beside and below them", async () => {
    const { fillGaps } = await import("./layout");
    const r = fillGaps({ a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 12, y: 0, w: 12, h: 24 }, c: { x: 0, y: 12, w: 12, h: 12 } }, 24);
    expect(r.a).toEqual({ x: 0, y: 0, w: 12, h: 12 });
    expect(r.b).toEqual({ x: 12, y: 0, w: 12, h: 24 });
    expect(r.c).toEqual({ x: 0, y: 12, w: 12, h: 12 });
  });
});
