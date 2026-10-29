import { kvGet, kvSet } from "../core/db";
import type { DashboardModule, GridPos } from "../modules/types";

export const COLS = 12;
export const ROWS = 40;
/** Bump when the default arrangement changes enough that old custom layouts no longer fit. */
export const LAYOUT_VERSION = 3;

export interface SavedLayout {
  version: number;
  /** False until the user edits the layout; until then new defaults apply automatically. */
  custom: boolean;
  items: Record<string, GridPos>;
  hidden: string[];
}

export interface ResolvedLayout {
  items: Record<string, GridPos>;
  hidden: string[];
  custom: boolean;
}

const overlaps = (a: GridPos, b: GridPos) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function fits(p: GridPos, taken: GridPos[]) {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= COLS && p.y + p.h <= ROWS && !taken.some((t) => overlaps(p, t));
}

/** First free spot for a card of this size, scanning top-left to bottom-right. */
export function findSpot(size: GridPos, taken: GridPos[]): GridPos | null {
  if (fits(size, taken)) return size;
  for (let y = 0; y <= ROWS - size.h; y++)
    for (let x = 0; x <= COLS - size.w; x++) {
      const p = { x, y, w: size.w, h: size.h };
      if (fits(p, taken)) return p;
    }
  return null;
}

/**
 * Merges the saved layout with the cards that exist now. Cards added in a
 * later version go into free space, or into the hidden tray if the screen is full.
 */
export function resolveLayout(saved: SavedLayout | null, modules: DashboardModule[]): ResolvedLayout {
  if (!saved || !saved.custom || saved.version !== LAYOUT_VERSION) {
    return {
      items: Object.fromEntries(modules.filter((m) => !m.defaultHidden).map((m) => [m.id, m.defaultPos])),
      hidden: modules.filter((m) => m.defaultHidden).map((m) => m.id),
      custom: false,
    };
  }
  const items: Record<string, GridPos> = {};
  const hidden: string[] = [];
  for (const m of modules) {
    if (saved.hidden.includes(m.id)) hidden.push(m.id);
    else if (saved.items[m.id]) items[m.id] = saved.items[m.id];
  }
  for (const m of modules) {
    if (items[m.id] || hidden.includes(m.id)) continue;
    const spot = findSpot(m.defaultPos, Object.values(items));
    if (spot) items[m.id] = spot;
    else hidden.push(m.id);
  }
  return { items, hidden, custom: true };
}

export function loadLayout() {
  return kvGet<SavedLayout | null>("layout", null);
}

export function saveLayout(l: ResolvedLayout) {
  const saved: SavedLayout = { version: LAYOUT_VERSION, custom: l.custom, items: l.items, hidden: l.hidden };
  return kvSet("layout", saved);
}
