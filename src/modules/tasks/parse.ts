import { addDays, dateKey, parseKey } from "../../core/time";

export interface ParsedTask {
  title: string;
  project: string | null;
  /** 1 = high, 2 = medium, 3 = low, null = none */
  priority: number | null;
  /** YYYY-MM-DD */
  due: string | null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PRIORITY: Record<string, number> = { "1": 1, high: 1, h: 1, "2": 2, med: 2, medium: 2, m: 2, "3": 3, low: 3, l: 3 };

/** Resolves "@…" date words relative to `today` (YYYY-MM-DD). Returns null if not a date. */
export function parseDue(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === "today" || w === "tod") return today;
  if (w === "tomorrow" || w === "tom" || w === "tmr") return addDays(today, 1);
  if (w === "nextweek" || w === "nw") {
    const dow = parseKey(today).getDay();
    return addDays(today, ((8 - dow) % 7) || 7); // next Monday
  }
  // "fri", "frid", "friday" — any prefix of at least three letters.
  const dayIdx = w.length >= 3 ? DAYS.findIndex((d) => fullDay(d).startsWith(w)) : -1;
  if (dayIdx >= 0) {
    const dow = parseKey(today).getDay();
    return addDays(today, (dayIdx - dow + 7) % 7); // the coming one, today included
  }
  let m = /^\+(\d{1,3})d?$/.exec(w) ?? /^(\d{1,3})d$/.exec(w);
  if (m) return addDays(today, Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // Day/month (UK order), e.g. 3/11 or 3.11 or 3/11/27
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(w);
  if (m) {
    const day = +m[1];
    const month = +m[2];
    if (m[3]) return valid(m[3].length === 2 ? 2000 + +m[3] : +m[3], month, day);
    const ty = parseKey(today).getFullYear();
    const thisYear = valid(ty, month, day);
    // A date already past this year means next year.
    return thisYear && thisYear < today ? valid(ty + 1, month, day) : thisYear;
  }
  return null;
}

function fullDay(d: string) {
  return { sun: "sunday", mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday" }[d]!;
}

function valid(y: number, m: number, d: number): string | null {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dateKey(dt) : null;
}

/**
 * "Email supervisor about chapter 2 #thesis !1 @fri"
 *   → title "Email supervisor about chapter 2", project "thesis", priority 1, due Friday.
 * Tokens that don't parse are left in the title.
 */
export function parseTask(input: string, today: string): ParsedTask {
  const out: ParsedTask = { title: "", project: null, priority: null, due: null };
  const words: string[] = [];
  for (const token of input.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.length > 1 && token.startsWith("#")) {
      out.project = token.slice(1).replace(/[-_]/g, " ");
      continue;
    }
    if (token.length > 1 && token.startsWith("!") && PRIORITY[token.slice(1).toLowerCase()] !== undefined) {
      out.priority = PRIORITY[token.slice(1).toLowerCase()];
      continue;
    }
    if (token.length > 1 && token.startsWith("@")) {
      const due = parseDue(token.slice(1), today);
      if (due) {
        out.due = due;
        continue;
      }
    }
    words.push(token);
  }
  out.title = words.join(" ");
  return out;
}
