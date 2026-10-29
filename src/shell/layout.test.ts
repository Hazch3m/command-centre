import { describe, expect, it } from "vitest";
import type { DashboardModule } from "../modules/types";
import { findSpot, resolveLayout, type SavedLayout } from "./layout";

const mod = (id: string, x: number, y: number, w: number, h: number) => ({ id, title: id, defaultPos: { x, y, w, h }, Card: () => null }) as DashboardModule;

describe("resolveLayout", () => {
  const mods = [mod("a", 0, 0, 12, 4), mod("b", 0, 4, 6, 10), mod("c", 0, 4, 6, 10)];

  it("uses defaults until customised", () => {
    expect(resolveLayout(null, mods).items.b).toEqual({ x: 0, y: 4, w: 6, h: 10 });
  });

  it("keeps saved positions and places new cards in free space", () => {
    const saved: SavedLayout = { version: 4, custom: true, items: { a: { x: 0, y: 0, w: 12, h: 4 }, b: { x: 0, y: 4, w: 6, h: 10 } }, hidden: [] };
    const r = resolveLayout(saved, mods);
    expect(r.items.c).toEqual({ x: 6, y: 4, w: 6, h: 10 });
    expect(r.hidden).toEqual([]);
  });

  it("puts a new card in the hidden tray when the screen is full", () => {
    const saved: SavedLayout = { version: 4, custom: true, items: { a: { x: 0, y: 0, w: 12, h: 40 } }, hidden: ["b"] };
    expect(resolveLayout(saved, mods).hidden).toEqual(["b", "c"]);
  });

  it("goes back to the defaults when the saved layout is from an older version", () => {
    const saved: SavedLayout = { version: 1, custom: true, items: { a: { x: 0, y: 0, w: 6, h: 4 } }, hidden: ["b"] };
    const r = resolveLayout(saved, mods);
    expect(r.custom).toBe(false);
    expect(r.items.a).toEqual({ x: 0, y: 0, w: 12, h: 4 });
  });

  it("finds no spot when nothing fits", () => {
    expect(findSpot({ x: 0, y: 0, w: 13, h: 1 }, [])).toBeNull();
  });
});
