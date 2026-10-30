import { kvGet, kvSet } from "../core/db";
import type { DashboardModule, GridPos } from "../modules/types";

/**
 * The overview is a 24-column grid that fills the screen. Portrait and
 * landscape screens each get their own arrangement (and remember their own
 * edits), so the same app works on the tall home monitor and a wide work one.
 */
export type Orientation = "portrait" | "landscape";
export const COLS = 24;
export const ROWS: Record<Orientation, number> = { portrait: 48, landscape: 24 };
/** Bump when the default arrangement changes enough that old custom layouts no longer fit. */
export const LAYOUT_VERSION = 5;

export const orientationOf = (w: number, h: number): Orientation => (h > w ? "portrait" : "landscape");

/** Default tiles per orientation. Modules not listed fall back to their own defaultPos (scaled). */
export const DEFAULTS: Record<Orientation, Record<string, GridPos>> = {
  portrait: {
    running: { x: 0, y: 0, w: 13, h: 11 },
    fitness: { x: 13, y: 0, w: 11, h: 11 },
    "training-week": { x: 0, y: 11, w: 24, h: 8 },
    health: { x: 0, y: 19, w: 12, h: 11 },
    checklist: { x: 12, y: 19, w: 12, h: 11 },
    calendar: { x: 0, y: 30, w: 12, h: 18 },
    tasks: { x: 12, y: 30, w: 12, h: 18 },
  },
  landscape: {
    running: { x: 0, y: 0, w: 8, h: 10 },
    fitness: { x: 8, y: 0, w: 8, h: 10 },
    health: { x: 16, y: 0, w: 8, h: 10 },
    "training-week": { x: 0, y: 10, w: 16, h: 7 },
    checklist: { x: 16, y: 10, w: 8, h: 7 },
    calendar: { x: 0, y: 17, w: 8, h: 7 },
    tasks: { x: 8, y: 17, w: 8, h: 7 },
    "latest-run": { x: 16, y: 17, w: 8, h: 7 },
  },
};

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

function fits(p: GridPos, taken: GridPos[], rows: number) {
  return p.x >= 0 && p.y >= 0 && p.x + p.w <= COLS && p.y + p.h <= rows && !taken.some((t) => overlaps(p, t));
}

/** First free spot for a card of this size, scanning top-left to bottom-right. */
export function findSpot(size: GridPos, taken: GridPos[], rows: number): GridPos | null {
  if (fits(size, taken, rows)) return size;
  for (let y = 0; y <= rows - size.h; y++)
    for (let x = 0; x <= COLS - size.w; x++) {
      const p = { x, y, w: size.w, h: size.h };
      if (fits(p, taken, rows)) return p;
    }
  return null;
}

/** A module's default tile for this orientation (old 12×40 positions are scaled up). */
export function defaultFor(m: DashboardModule, o: Orientation): GridPos {
  const d = DEFAULTS[o][m.id];
  if (d) return d;
  const p = m.defaultPos;
  const ry = ROWS[o] / 40;
  return { x: Math.min(COLS - 2, p.x * 2), y: Math.round(p.y * ry), w: Math.min(COLS, p.w * 2), h: Math.max(2, Math.round(p.h * ry)) };
}

const shownByDefault = (m: DashboardModule, o: Orientation) => !!DEFAULTS[o][m.id] || (!m.defaultHidden && !Object.keys(DEFAULTS[o]).length);

/**
 * Merges the saved layout with the cards that exist now. Cards added in a
 * later version go into free space, or into the hidden tray if the screen is full.
 */
export function resolveLayout(saved: SavedLayout | null, modules: DashboardModule[], o: Orientation = "portrait"): ResolvedLayout {
  const rows = ROWS[o];
  if (!saved || !saved.custom || saved.version !== LAYOUT_VERSION) {
    const items: Record<string, GridPos> = {};
    const hidden: string[] = [];
    for (const m of modules) {
      const show = DEFAULTS[o][m.id] ? true : Object.keys(DEFAULTS[o]).length ? false : !m.defaultHidden;
      if (show) items[m.id] = defaultFor(m, o);
      else hidden.push(m.id);
    }
    return { items, hidden, custom: false };
  }
  const items: Record<string, GridPos> = {};
  const hidden: string[] = [];
  for (const m of modules) {
    if (saved.hidden.includes(m.id)) hidden.push(m.id);
    else if (saved.items[m.id]) items[m.id] = saved.items[m.id];
  }
  for (const m of modules) {
    if (items[m.id] || hidden.includes(m.id)) continue;
    const spot = shownByDefault(m, o) ? findSpot(defaultFor(m, o), Object.values(items), rows) : null;
    if (spot) items[m.id] = spot;
    else hidden.push(m.id);
  }
  return { items, hidden, custom: true };
}

export function loadLayout(o: Orientation) {
  return kvGet<SavedLayout | null>(`layout.${o}`, null);
}

export function saveLayout(l: ResolvedLayout, o: Orientation) {
  const saved: SavedLayout = { version: LAYOUT_VERSION, custom: l.custom, items: l.items, hidden: l.hidden };
  return kvSet(`layout.${o}`, saved);
}
