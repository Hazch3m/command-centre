import { kvGet, kvSet } from "./db";

/** App-wide preferences stored in SQLite (kv table). */
export interface Settings {
  /** Hour (0–23) when "today" rolls over for checklists and due dates. */
  dayResetHour: number;
  /** Hide the mouse pointer after a few seconds without movement. */
  hideCursor: boolean;
  /** Colour scheme. "system" follows Windows' light/dark setting. */
  theme: "light" | "dark" | "system";
  /** Text size multiplier on top of the size that scales with the screen. */
  textScale: number;
}

const DEFAULTS: Settings = { dayResetHour: 4, hideCursor: true, theme: "light", textScale: 1 };

export const TEXT_SIZES = [
  { label: "Small", value: 0.9 },
  { label: "Medium", value: 1 },
  { label: "Large", value: 1.15 },
  { label: "Extra large", value: 1.3 },
];

const darkQuery = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** Puts the theme and text size on <html>, where the stylesheet reads them. */
export function applyAppearance(s: Settings = current) {
  if (typeof document === "undefined") return;
  const dark = s.theme === "dark" || (s.theme === "system" && !!darkQuery?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--scale", String(s.textScale || 1));
}
darkQuery?.addEventListener?.("change", () => applyAppearance());
let current: Settings = DEFAULTS;
const subs = new Set<() => void>();

export async function loadSettings() {
  current = { ...DEFAULTS, ...(await kvGet<Partial<Settings>>("settings", {})) };
  applyAppearance();
  subs.forEach((s) => s());
}

export function getSettings(): Settings {
  return current;
}

export function subscribeSettings(cb: () => void) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export async function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  applyAppearance();
  subs.forEach((s) => s());
  await kvSet("settings", current);
}
