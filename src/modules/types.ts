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
  /** Where the card sits in the default portrait layout (12 columns × 30 rows). */
  defaultPos: GridPos;
  minW?: number;
  minH?: number;
  /** SQL migrations, run once each in order. Only ever append. */
  migrations?: string[];
  Card: ComponentType<CardProps>;
  quickAdd?: QuickAddTarget[];
  /** Optional one-off setup after migrations (e.g. seeding defaults on first run). */
  init?: () => Promise<void>;
}
