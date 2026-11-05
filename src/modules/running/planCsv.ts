import { addDays } from "../../core/time";
import { mondayOf, WEEK_KEYS, type DayKey, type Plan, type PlanRace, type PlanWeek } from "./plan";

/**
 * Reads a training plan from a CSV, so any plan (a coach's spreadsheet, an
 * export from another app) can be brought in and checked for race readiness.
 *
 * Two layouts are understood:
 *  - one row per day: date, workout [, distance km] [, notes]
 *  - one row per week: week start, mon, tue, … sun [, km]
 * Header names are matched loosely ("Date", "Workout"/"Session"/"Description",
 * "Distance"/"km"; "Week"/"Week start"; "Mon"/"Monday" …).
 */

export const CSV_TEMPLATE_DAYS = `date,workout,distance_km,notes
2027-01-04,Rest,,
2027-01-05,5 × 1 km at 3:30 2 min jog,12,Track
2027-01-06,Easy run,10,
2027-01-07,20 min T at 3:45,12,
2027-01-08,Rest,,
2027-01-09,Easy + 6 × 20 s strides,8,
2027-01-10,Long run,24,
2027-04-25,Marathon race,42.2,Goal race`;

export const CSV_TEMPLATE_WEEKS = `week_start,mon,tue,wed,thu,fri,sat,sun
2027-01-04,Rest,12 km with 5 × 1 km at 3:30,10 km easy,12 km with 20 min T at 3:45,Rest,8 km easy + strides,24 km long run
2027-01-11,Rest,13 km with 6 × 1 km at 3:30,12 km easy,13 km with 25 min T at 3:45,Rest,8 km easy + strides,26 km long run`;

/** Splits CSV text into rows, handling quotes, commas, semicolons or tabs. */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const first = clean.split("\n")[0] ?? "";
  const sep = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? "\t" : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (q) {
      if (c === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      row.push(cell.trim());
      cell = "";
    } else if (c === "\n") {
      row.push(cell.trim());
      if (row.some((x) => x)) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

/** "2027-01-04", "04/01/2027", "4.1.2027", "4 Jan 2027" → YYYY-MM-DD. Day first for slashes (UK/European style). */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(t);
  if (m) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  m = /^(?:[a-z]+,?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})$/i.exec(t);
  if (m && months.includes(m[2].toLowerCase())) return `${m[3]}-${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

export interface CsvPlan {
  weeks: PlanWeek[];
  layout: "days" | "weeks";
  /** Rows that looked like races, as suggestions for the goal race. */
  raceRows: { date: string; text: string; km: number | null }[];
  warnings: string[];
}

const RACE = /\brace\b|marathon|parkrun|\bhalf\b|\b10k\b|\b5k\b|time trial/i;
const asKm = (s: string | undefined) => {
  if (!s) return null;
  const m = /([\d.,]+)\s*(km|mi|miles?)?/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  if (!isFinite(v) || v <= 0) return null;
  return /mi/i.test(m[2] ?? "") ? Math.round(v * 1.609 * 10) / 10 : v;
};
/** A day's text in the form the plan reads: leading km when a distance is given ("12 km easy run"). */
function sessionText(text: string, km: number | null): string {
  // "6 x 800m" → "6 × 800 m", the way the plan writes reps.
  const t = text
    .trim()
    .replace(/(\d)\s*[xX]\s*(\d)/g, "$1 × $2")
    .replace(/(\d)(km|m|s|min)\b/g, "$1 $2");
  if (!t || /^(rest|off|none|-)$/i.test(t)) return "Rest";
  if (km == null || /^\d+(?:\.\d+)?\s*km\b/i.test(t)) return t;
  const lower = t.charAt(0).toLowerCase() + t.slice(1);
  return /\d\s*×\s*[\d.]+\s*(?:km|m|min)\b|\bat\s+\d:\d\d|\bT\b|tempo|interval|threshold|\bMP\b/i.test(t) ? `${km} km with ${lower}` : `${km} km ${lower}`;
}

export function csvToWeeks(text: string): CsvPlan {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("The CSV needs a header row and at least one row of training.");
  const head = rows[0].map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const col = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)));
  const warnings: string[] = [];
  const raceRows: CsvPlan["raceRows"] = [];
  const byWeek = new Map<string, Partial<Record<DayKey, string>>>();
  const weekKm = new Map<string, number>();
  const dayCols = WEEK_KEYS.map((k) => head.findIndex((h) => h.startsWith(k)));
  let layout: CsvPlan["layout"];
  if (dayCols.filter((i) => i >= 0).length >= 5) {
    layout = "weeks";
    const wc = col(/^weekstart/, /^week(?!ly)/, /^start/, /^date/);
    if (wc < 0) throw new Error('A week-per-row CSV needs a "week start" column with the Monday of each week.');
    const kmCol = col(/^km$/, /^distance/, /^total/, /^weeklykm/);
    for (const r of rows.slice(1)) {
      const d = parseDate(r[wc] ?? "");
      if (!d) {
        warnings.push(`Skipped a row: "${r[wc]}" isn't a date.`);
        continue;
      }
      const monday = mondayOf(d);
      const s: Partial<Record<DayKey, string>> = {};
      WEEK_KEYS.forEach((k, i) => {
        const cell = dayCols[i] >= 0 ? r[dayCols[i]] ?? "" : "";
        s[k] = sessionText(cell, null);
        if (RACE.test(cell)) raceRows.push({ date: addDays(monday, i), text: cell, km: asKm(cell) });
      });
      byWeek.set(monday, s);
      const k = kmCol >= 0 ? asKm(r[kmCol]) : null;
      if (k) weekKm.set(monday, k);
    }
  } else {
    layout = "days";
    const dc = col(/^date/, /^day$/);
    const tc = col(/^workout/, /^session/, /^description/, /^activity/, /^training/, /^plan/, /^title/, /^name/);
    if (dc < 0 || tc < 0) throw new Error('Couldn\'t find the columns. Use a "date" and a "workout" column (one row per day), or "week_start" and "mon"…"sun" (one row per week).');
    const kc = col(/^distancekm/, /^distance/, /^km$/, /^kms$/);
    const nc = col(/^notes?/, /^comment/);
    for (const r of rows.slice(1)) {
      const d = parseDate(r[dc] ?? "");
      if (!d) {
        if (r[dc]) warnings.push(`Skipped a row: "${r[dc]}" isn't a date.`);
        continue;
      }
      const km = kc >= 0 ? asKm(r[kc]) : null;
      const text = r[tc] ?? "";
      const monday = mondayOf(d);
      const s = byWeek.get(monday) ?? {};
      const key = WEEK_KEYS[(new Date(d + "T12:00").getDay() + 6) % 7];
      const t = sessionText(text, km);
      s[key] = s[key] && s[key] !== "Rest" ? `${s[key]} + ${t}` : t;
      byWeek.set(monday, s);
      if (RACE.test(`${text} ${nc >= 0 ? r[nc] ?? "" : ""}`)) raceRows.push({ date: d, text, km });
    }
  }
  if (!byWeek.size) throw new Error("No training rows with dates were found.");
  const mondays = [...byWeek.keys()].sort();
  const weeks: PlanWeek[] = [];
  for (let m = mondays[0], n = 1; m <= mondays[mondays.length - 1]; m = addDays(m, 7), n++) {
    const s = byWeek.get(m) ?? {};
    for (const k of WEEK_KEYS) s[k] ??= "Rest";
    const total = WEEK_KEYS.reduce((a, k) => a + (parseFloat(/^(\d+(?:\.\d+)?)\s*km/i.exec(s[k]!)?.[1] ?? "0") || 0), 0);
    const km = weekKm.get(m) ?? Math.round(total);
    weeks.push({ week: String(n), start: m, end: addDays(m, 6), phase: "Imported", km: String(km || ""), kmMin: km || null, kmMax: km || null, sessions: s, notes: "" });
  }
  const unsized = weeks.reduce((a, w) => a + WEEK_KEYS.filter((k) => w.sessions[k] !== "Rest" && !/\d\s*(km|min)\b/i.test(w.sessions[k]!)).length, 0);
  if (unsized) warnings.push(`${unsized} day${unsized === 1 ? " has" : "s have"} no distance; they're sized from each week's total, so readiness is approximate.`);
  return { weeks, layout, raceRows, warnings };
}

/** The imported weeks merged into the current plan (earlier weeks and weeks after kept), with the goal race added. */
export function mergeImported(old: Plan, imp: CsvPlan, race: PlanRace | null, fileName: string, today: string): Plan {
  const start = imp.weeks[0].start;
  const end = imp.weeks[imp.weeks.length - 1].end;
  const races = [...old.races.filter((r) => !r.date || r.date < start || r.date > end), ...(race ? [race] : [])].sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
  const { previous: _p, baseWeeks: _b, prefs: _q, hrZones: _h, ...prev } = old;
  return {
    ...old,
    title: race ? `${race.name}${race.target ? ` · ${race.target}` : ""}` : `Imported plan`,
    source: `Imported from ${fileName}`,
    exported: today,
    phases: [...old.phases.filter((p) => p.end && p.end < start), { name: "Imported plan", start, end, summary: `${imp.weeks.length} weeks from ${fileName}.` }, ...old.phases.filter((p) => p.start && p.start > end)],
    blocks: old.blocks.filter((b) => !b.start || b.start > end || (b.end && b.end < start)),
    races,
    weeks: [...old.weeks.filter((w) => w.end < start), ...imp.weeks, ...old.weeks.filter((w) => w.start > end)],
    adjust: null,
    baseWeeks: undefined,
    built: undefined,
    previous: prev,
  };
}
