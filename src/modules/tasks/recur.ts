import { addDays, dateKey, parseKey } from "../../core/time";

/**
 * Repeat rules, stored as short strings:
 *   "d:N"           every N days
 *   "wd"            every weekday (Mon–Fri)
 *   "w:N:1,4"       every N weeks on the given weekdays (0 = Sun); empty list = the anchor's weekday
 *   "m:N"           every N months on the anchor's day of month (clamped to month end)
 */
export type Recur = string;

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABEL = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Quick-add token after "*": daily, weekdays, weekly, monthly, mon, mon,thu, 2w, 3d, 2m. */
export function parseRecurToken(tok: string): Recur | null {
  const t = tok.toLowerCase();
  if (t === "daily" || t === "day" || t === "d") return "d:1";
  if (t === "weekdays" || t === "wd") return "wd";
  if (t === "weekly" || t === "week" || t === "w") return "w:1:";
  if (t === "fortnightly") return "w:2:";
  if (t === "monthly" || t === "month" || t === "m") return "m:1";
  let m = /^(\d{1,2})([dwm])$/.exec(t);
  if (m) return m[2] === "w" ? `w:${+m[1]}:` : `${m[2]}:${+m[1]}`;
  const parts = t.split(",");
  const idx = parts.map((p) => (p.length >= 3 ? DAY_NAMES.findIndex((d) => d === p.slice(0, 3)) : -1));
  if (idx.length && idx.every((i) => i >= 0)) return `w:1:${[...new Set(idx)].sort().join(",")}`;
  return null;
}

export function describeRecur(r: Recur | null | undefined): string {
  if (!r) return "";
  if (r === "wd") return "Weekdays";
  const [kind, n, days] = r.split(":");
  const every = Number(n) || 1;
  if (kind === "d") return every === 1 ? "Daily" : `Every ${every} days`;
  if (kind === "m") return every === 1 ? "Monthly" : `Every ${every} months`;
  if (kind === "w") {
    const list = days ? days.split(",").map((d) => DAY_LABEL[+d]).join(", ") : "";
    const base = every === 1 ? "Weekly" : every === 2 ? "Fortnightly" : `Every ${every} weeks`;
    return list ? `${base} on ${list}` : base;
  }
  return r;
}

/** The next date strictly after `from` (YYYY-MM-DD) on which the rule falls. */
export function nextOccurrence(r: Recur, from: string): string {
  if (r === "wd") {
    let d = addDays(from, 1);
    while ([0, 6].includes(parseKey(d).getDay())) d = addDays(d, 1);
    return d;
  }
  const [kind, n, days] = r.split(":");
  const every = Math.max(1, Number(n) || 1);
  if (kind === "d") return addDays(from, every);
  if (kind === "m") {
    const f = parseKey(from);
    const target = new Date(f.getFullYear(), f.getMonth() + every, 1);
    const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(f.getDate(), lastDay));
    return dateKey(target);
  }
  if (kind === "w") {
    const list = days ? days.split(",").map(Number) : [parseKey(from).getDay()];
    // Within the current week (Mon-based), a later listed day comes first.
    const dow = parseKey(from).getDay();
    const iso = (d: number) => (d + 6) % 7; // Mon = 0
    const later = list.filter((d) => iso(d) > iso(dow)).sort((a, b) => iso(a) - iso(b));
    if (later.length) return addDays(from, iso(later[0]) - iso(dow));
    const first = list.slice().sort((a, b) => iso(a) - iso(b))[0];
    return addDays(from, 7 * every - iso(dow) + iso(first));
  }
  return addDays(from, 1);
}
