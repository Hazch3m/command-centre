import { kvGet, kvSet } from "./db";

/** App-wide preferences stored in SQLite (kv table). */
export interface Settings {
  /** Hour (0–23) when "today" rolls over for checklists and due dates. */
  dayResetHour: number;
  /** Hide the mouse pointer after a few seconds without movement. */
  hideCursor: boolean;
}

const DEFAULTS: Settings = { dayResetHour: 4, hideCursor: true };
let current: Settings = DEFAULTS;
const subs = new Set<() => void>();

export async function loadSettings() {
  current = { ...DEFAULTS, ...(await kvGet<Partial<Settings>>("settings", {})) };
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
  subs.forEach((s) => s());
  await kvSet("settings", current);
}
