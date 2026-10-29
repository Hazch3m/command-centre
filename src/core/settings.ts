import { kvGet, kvSet } from "./db";

/** App-wide preferences stored in SQLite (kv table). */
export interface Settings {
  /** Hour (0–23) when "today" rolls over for checklists and due dates. */
  dayResetHour: number;
  /** Hide the mouse pointer after a few seconds without movement. */
  hideCursor: boolean;
  /** Colour scheme. "slate" is the mid-tone default; "system" follows Windows' light/dark setting. */
  theme: "slate" | "light" | "dark" | "system";
  /** Bumped when the appearance defaults change, so older saved choices reset once. */
  appearanceVersion?: number;
  /** Text size multiplier on top of the size that scales with the screen. */
  textScale: number;
}

const APPEARANCE_VERSION = 2;
const DEFAULTS: Settings = { dayResetHour: 4, hideCursor: true, theme: "slate", textScale: 1, appearanceVersion: APPEARANCE_VERSION };

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
  document.documentElement.dataset.theme = s.theme === "system" ? (darkQuery?.matches ? "dark" : "light") : s.theme;
  document.documentElement.style.setProperty("--scale", String(s.textScale || 1));
}
darkQuery?.addEventListener?.("change", () => applyAppearance());
let current: Settings = DEFAULTS;
const subs = new Set<() => void>();

export async function loadSettings() {
  const saved = await kvGet<Partial<Settings>>("settings", {});
  current = { ...DEFAULTS, ...saved };
  if ((saved.appearanceVersion ?? 0) < APPEARANCE_VERSION) current = { ...current, theme: "slate", appearanceVersion: APPEARANCE_VERSION };
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
