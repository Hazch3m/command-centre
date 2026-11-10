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
export const LAYOUT_VERSION = 6;

export const orientationOf = (w: number, h: number): Orientation => (h > w ? "portrait" : "landscape");

/**
 * Default tiles per orientation: running first. Calendar, to-do and habits have their own Planner
 * tab, so they're off the overview unless you add them (Edit). Modules not listed are hidden.
 */
export const DEFAULTS: Record<Orientation, Record<string, GridPos>> = {
  portrait: {
    running: { x: 0, y: 0, w: 13, h: 12 },
    fitness: { x: 13, y: 0, w: 11, h: 12 },
    "training-week": { x: 0, y: 12, w: 24, h: 8 },
    predictions: { x: 0, y: 20, w: 12, h: 8 },
    health: { x: 12, y: 20, w: 12, h: 8 },
    "latest-run": { x: 0, y: 28, w: 12, h: 10 },
    weather: { x: 12, y: 28, w: 12, h: 10 },
  },
  landscape: {
    running: { x: 0, y: 0, w: 8, h: 12 },
    fitness: { x: 8, y: 0, w: 8, h: 12 },
    health: { x: 16, y: 0, w: 8, h: 12 },
    "training-week": { x: 0, y: 12, w: 12, h: 12 },
    predictions: { x: 12, y: 12, w: 6, h: 12 },
    weather: { x: 18, y: 12, w: 6, h: 12 },
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
  // Cards pushed below the bottom of the screen (by dragging others onto them) come back
  // into free space, or go to the hidden tray rather than being stuck out of sight.
  const fixed = fitToScreen(items, rows);
  for (const id of fixed.hidden) {
    delete items[id];
    hidden.push(id);
  }
  Object.assign(items, fixed.items);
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

/**
 * Brings back cards that sit (partly) below the last row: first into free
 * space at their own size, then at a smaller size, else they're listed as
 * hidden. Cards already on screen don't move.
 */
export function fitToScreen(items: Record<string, GridPos>, rows: number): { items: Record<string, GridPos>; hidden: string[]; moved: string[] } {
  const out: Record<string, GridPos> = {};
  const off: [string, GridPos][] = [];
  for (const [id, p] of Object.entries(items)) {
    if (p.y + p.h <= rows && p.x + p.w <= COLS) out[id] = p;
    else off.push([id, p]);
  }
  const hidden: string[] = [];
  const moved: string[] = [];
  for (const [id, p] of off.sort((a, b) => a[1].y - b[1].y)) {
    const taken = Object.values(out);
    const spot =
      findSpot({ ...p, x: Math.min(p.x, COLS - p.w), y: Math.max(0, Math.min(p.y, rows - p.h)) }, taken, rows) ??
      findSpot({ x: 0, y: 0, w: Math.min(p.w, 8), h: Math.min(p.h, Math.max(3, Math.round(rows / 6))) }, taken, rows) ??
      findSpot({ x: 0, y: 0, w: 4, h: 3 }, taken, rows);
    if (spot) {
      out[id] = spot;
      moved.push(id);
    } else hidden.push(id);
  }
  return { items: out, hidden, moved };
}

/**
 * Grows cards into empty grid space next to them (down, right, then up and
 * left), so the dashboard has no holes between tiles.
 */
export function fillGaps(items: Record<string, GridPos>, rows: number): Record<string, GridPos> {
  const out: Record<string, GridPos> = {};
  for (const [id, p] of Object.entries(items)) out[id] = { ...p };
  const ids = Object.keys(out).sort((a, b) => out[a].y - out[b].y || out[a].x - out[b].x);
  const free = (id: string, x: number, y: number, w: number, h: number) =>
    x >= 0 && y >= 0 && x + w <= COLS && y + h <= rows && !ids.some((o) => o !== id && overlaps({ x, y, w, h }, out[o]));
  for (let pass = 0; pass < 3; pass++)
    for (const id of ids) {
      const p = out[id];
      while (free(id, p.x, p.y + p.h, p.w, 1)) p.h++;
      while (free(id, p.x + p.w, p.y, 1, p.h)) p.w++;
      while (free(id, p.x, p.y - 1, p.w, 1)) (p.y--, p.h++);
      while (free(id, p.x - 1, p.y, 1, p.h)) (p.x--, p.w++);
    }
  return out;
}
