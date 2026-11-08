import type { ComponentType } from "react";

export interface GridPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a card receives from the shell. */
export interface CardProps {
  /** True while the dashboard is in layout edit mode (cards should avoid stealing clicks). */
  editing: boolean;
  /** "tile" on the overview grid (keep it to the key facts), "page" when shown full-size in its own tab. */
  variant?: "tile" | "page";
}

/** A target the quick-add popup can write to (e.g. "Task", "Checklist item"). */
export interface QuickAddTarget {
  id: string;
  label: string;
  placeholder: string;
  /** Short help shown under the input, e.g. syntax hints. */
  hint?: string;
  /** Optional live preview of how the text will be interpreted. */
  preview?: (text: string) => string | null;
  /** Saves the text. Throw an Error with a friendly message to reject it. */
  add: (text: string) => Promise<void>;
}

/**
 * A dashboard card. To add one: create `src/modules/<name>/index.tsx` exporting
 * a `DashboardModule`, then add it to `registry.ts`.
 */
export interface DashboardModule {
  id: string;
  title: string;
  /** Where the tile sits on the overview (12 columns × 40 rows). */
  defaultPos: GridPos;
  /** Start hidden on the overview (it can be added back in edit mode). */
  defaultHidden?: boolean;
  /**
   * Gives the module its own tab at the top of the screen. `Page` defaults to
   * the Card rendered with variant "page".
   */
  /** A full page; `inTraining`: shown as a tab inside Training rather than across the top. */
  page?: { label: string; order: number; Page?: ComponentType; inTraining?: boolean };
  minW?: number;
  minH?: number;
  /** SQL migrations, run once each in order. Only ever append. */
  migrations?: string[];
  Card: ComponentType<CardProps>;
  quickAdd?: QuickAddTarget[];
  /** Optional one-off setup after migrations (e.g. seeding defaults on first run). */
  init?: () => Promise<void>;
}
