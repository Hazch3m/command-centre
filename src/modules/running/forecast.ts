import { addDays, parseKey } from "../../core/time";
import { blockFor, mondayOf, sessionFor, WEEK_KEYS, type Plan, type PlanRace, type PlanWeek } from "./plan";
import { km, parseTime } from "./stats";
import type { Run } from "./strava";

/**
 * Turns the plan into a day-by-day forecast: what to run each day, roughly how
 * far, and at what pace. Named sessions come from the plan's week table; the
 * other days come from the weekly structure, sized so the week adds up to its
 * kilometre target.
 */

export type DayKind = "key" | "long" | "easy" | "optional" | "rest" | "race";

export interface ForecastDay {
  date: string;
  dow: string;
  text: string;
  kind: DayKind;
  /** Estimated km; null when unknown (outside the plan). */
  km: number | null;
  pace: string | null;
  strength: "A" | "B" | null;
  race: PlanRace | null;
  actualKm: number;
  runs: Run[];
  /** You changed this day (the plan's own text is in `planText`). */
  edited?: boolean;
  planText?: string;
}

export interface ForecastWeek {
  monday: string;
  week: PlanWeek | null;
  block: ReturnType<typeof blockFor>;
  days: ForecastDay[];
  plannedKm: number | null;
  actualKm: number;
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WARM = 5; // warm-up + cool-down around a workout, km
const EASY_PACE = 320; // s/km, middle of the plan's easy range
const JOG_PACE = 360;

const num = (s: string) => parseFloat(s.replace(",", ""));
const mid = (a: number, b: number) => (a + b) / 2;

/** "3:46–3:50" → seconds per km (middle of the range), or null. */
function paceIn(text: string): number | null {
  const m = /(\d:\d{2})(?:\s*[–-]\s*(\d:\d{2}))?/.exec(text);
  if (!m) return null;
  const a = parseTime(m[1])!;
  return m[2] ? mid(a, parseTime(m[2])!) : a;
}

/** Distance of a race from its name. */
export function raceKm(name: string): number | null {
  if (/marathon/i.test(name) && !/half/i.test(name)) return 42.2;
  if (/half/i.test(name)) return 21.1;
  const m = /(\d+(?:\.\d+)?)\s*k\b/i.exec(name);
  return m ? num(m[1]) : null;
}

/** km of one "A × B unit at pace, R jog" block. */
function repsKm(text: string, defaultPace: number): number | null {
  const m = /(\d+)\s*×\s*([\d.,]+)\s*(km|m|min|s)\b(?:\s*on,\s*([\d.,]+)\s*(min|s)\s*off)?/.exec(text);
  if (!m) return null;
  const reps = +m[1];
  const size = num(m[2]);
  const pace = paceIn(text.slice(m.index)) ?? defaultPace;
  let work = 0;
  if (m[3] === "km") work = reps * size;
  else if (m[3] === "m") work = (reps * size) / 1000;
  else if (m[3] === "min") work = (reps * size * 60) / pace;
  else work = (reps * size) / pace;
  // Recoveries: "2 min jog", "90 s jog", "200 m jog", or fartlek "1 min off".
  let rec = 0;
  const off = m[4] ? { v: num(m[4]), u: m[5] } : null;
  const j = off ?? (() => {
    const r = /([\d.,:]+)\s*(min|s|m)\s*jog/.exec(text);
    if (!r) return null;
    if (r[1].includes(":")) return { v: parseTime(r[1])! / 60, u: "min" };
    return { v: num(r[1]), u: r[2] };
  })();
  if (j) {
    const n = off ? reps : reps - 1;
    if (j.u === "m") rec = (n * j.v) / 1000;
    else rec = (n * j.v * (j.u === "min" ? 60 : 1)) / JOG_PACE;
  }
  return work + rec;
}

/**
 * Estimated km for a session's text, or null when the text gives no distance
 * ("Easy + strides"), so the day is sized from the week's target instead.
 */
export function sessionKm(text: string, thresholdPace = 227): number | null {
  const t = text.trim();
  if (!t || /^(rest|none)\b/i.test(t)) return 0;
  const about = /about\s+([\d.]+)\s*km/i.exec(t);
  if (about) return num(about[1]);
  const lead = /^([\d.]+)(?:\s*[–-]\s*([\d.]+))?\s*km\b/i.exec(t);
  if (lead) return lead[2] ? mid(num(lead[1]), num(lead[2])) : num(lead[1]);
  const easyMin = /^easy\s+(\d+)\s*min/i.exec(t);
  if (easyMin) return (+easyMin[1] * 60) / EASY_PACE;
  const plainMin = /^(\d+)\s*min\b(?!\s*T\b)/i.exec(t);
  if (plainMin) return (+plainMin[1] * 60) / EASY_PACE;
  const isFartlek = /fartlek/i.test(t);
  // Reps, possibly two blocks: "3 × 2 km at 3:30 + 4 × 200 m fast".
  const blocks = t.split(/\s\+\s(?=\d+\s*×)/);
  let reps = 0;
  let any = false;
  for (const b of blocks) {
    const k = repsKm(b, isFartlek ? 210 : thresholdPace);
    if (k != null) {
      reps += k;
      any = true;
    }
  }
  if (any) return Math.round((reps + WARM) * 10) / 10;
  const tempo = /^(\d+)\s*min\s*T\b/i.exec(t);
  if (tempo) return Math.round(((+tempo[1] * 60) / (paceIn(t) ?? thresholdPace) + WARM) * 10) / 10;
  const someKm = /([\d.]+)\s*km/i.exec(t);
  if (someKm && !/\d\s*×/.test(t)) return num(someKm[1]);
  return null;
}

/** "10–14 km easy" → [10, 14]; "6–8 km recovery" → [6, 8]. */
function rangeIn(text: string): [number, number] | null {
  const m = /([\d.]+)(?:\s*[–-]\s*([\d.]+))?\s*km/i.exec(text);
  if (!m) return null;
  return [num(m[1]), m[2] ? num(m[2]) : num(m[1])];
}

/** "30 km long run", not "18 km medium-long run". */
const LONG_RUN = /(?<!medium-)\blong run\b/i;

function classify(text: string): DayKind {
  if (/at \d:\d\d|\bT\b|\bMP\b|HMP|fartlek|hill|\d\s*×\s*[\d.,]+\s*(km|m|min)\b/i.test(text)) return "key";
  return "easy";
}

function paceFor(plan: Plan, text: string, kind: DayKind): string | null {
  const zone = (re: RegExp) => plan.paces.find((p) => re.test(p.zone))?.now ?? null;
  const explicit = /(\d:\d{2}(?:\s*[–-]\s*\d:\d{2})?)/.exec(text);
  if (kind === "rest") return null;
  if (/\bHMP\b/.test(text)) return explicit?.[1] ?? zone(/^Half/i);
  if (/\bMP\b/.test(text)) return explicit?.[1] ?? zone(/^Marathon/i);
  if (explicit) return explicit[1];
  if (/\bT\b/.test(text)) return zone(/^Threshold/i);
  if (/recover/i.test(text)) return zone(/^Recovery/i);
  if (kind === "long") return zone(/^Long/i);
  if (/fartlek|hill|sprint/i.test(text)) return "by feel";
  return zone(/^Easy/i);
}

export function forecastWeek(plan: Plan, monday: string, runs: Run[] = [], overrides?: Map<string, string>): ForecastWeek {
  const week = plan.weeks.find((w) => w.start <= monday && monday <= w.end) ?? plan.weeks.find((w) => w.start > monday && w.start <= addDays(monday, 6)) ?? null;
  const block = week ? null : blockFor(plan, monday);
  const strengthFrom = plan.phases.find((p) => p.start)?.start ?? "";
  const threshold = paceIn(plan.paces.find((p) => /^Threshold/i.test(p.zone))?.now ?? "") ?? 227;

  // The plan sometimes puts another day's session inside one cell
  // ("Easy + strides. Sat 19 Dec: 5k time trial", "Easy 12 km. Thu: 2 × 5 km at 3:46").
  const notes = new Map<string, string>();
  if (week)
    for (const [day, text] of Object.entries(week.sessions)) {
      const own = DOW.find((d) => d.toLowerCase() === day)!;
      for (const seg of (text ?? "").split(/\.\s+(?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^:.]*:)/)) {
        const m = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^:.]*:\s*(.*)$/.exec(seg);
        if (m && m[1] !== own) notes.set(m[1], m[2].trim());
        else if (m) notes.set(own, m[2].trim());
      }
    }
  const ownText = (t: string) => t.split(/\.\s+(?=(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^:.]*:)/)[0].trim();

  const days: (ForecastDay & { flex?: [number, number]; optional?: boolean })[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    const dayRuns = runs.filter((r) => r.date === date);
    const actualKm = dayRuns.reduce((s, r) => s + km(r.distance), 0);
    const race = plan.races.find((r) => r.date === date && !r.approx) ?? null;
    const base: ForecastDay = { date, dow: DOW[i], text: "", kind: "easy", km: null, pace: null, strength: null, race, actualKm, runs: dayRuns };
    const ov = overrides?.get(date);
    if (ov != null) {
      const k = sessionKm(ov, threshold);
      const rest = /^(rest|none)\b/i.test(ov);
      const kind: DayKind = rest ? "rest" : DOW[i] === "Sun" && k != null && k >= 16 ? "long" : classify(ov);
      days.push({ ...base, text: rest ? "Rest" : ov, kind, km: k, pace: rest ? null : paceFor(plan, ov, kind), edited: true, flex: k == null && week ? [8, 12] : undefined });
      continue;
    }
    if (!week) {
      days.push({ ...base, kind: "optional" });
      continue;
    }
    const s = sessionFor(plan, date);
    const structure = plan.structure.find((r) => r.day.toLowerCase().startsWith(DOW[i].toLowerCase()));
    const structText = structure ? (/phase 3/i.test(week.phase) ? structure.phase3 : structure.phases12) : "";
    if (date >= strengthFrom) {
      const st = /strength\s+([AB])\b/.exec(structText);
      if (st) base.strength = st[1] as "A" | "B";
    }
    if (race) {
      const rk = race.km ?? raceKm(race.name);
      const said = s?.key ? /about\s+([\d.]+)\s*km/i.exec(s.text) : null;
      const k = said ? num(said[1]) : rk == null ? null : rk > 40 ? rk : rk + WARM;
      days.push({ ...base, text: `${race.name} · ${race.target}`, kind: "race", km: k, pace: null });
      continue;
    }
    const own = notes.get(DOW[i]);
    const text = own ?? (s?.key ? ownText(s.text) : "");
    if (own != null || s?.key) {
      const k = sessionKm(text, threshold);
      const rest = /^(rest|none)\b/i.test(text);
      const kind: DayKind = rest ? "rest" : LONG_RUN.test(text) || (DOW[i] === "Sun" && (k == null || k >= 16)) ? "long" : classify(text);
      days.push({ ...base, text: rest ? "Rest" : text, kind, km: k, flex: k == null ? [8, 12] : undefined });
    } else {
      const optional = /^rest,?\s*or/i.test(structText);
      const range = rangeIn(structText);
      const easyText = structText.replace(/\s*\+\s*strength [AB]/i, "").replace(/^Rest,?\s*or\s*/i, "");
      days.push({
        ...base,
        text: optional ? `Rest, or ${easyText}` : easyText,
        kind: optional ? "optional" : /long/i.test(structText) ? "long" : "easy",
        km: null,
        flex: range ?? [8, 12],
        optional,
      });
    }
  }

  // The long run needn't be on Sunday (the plan can move it): the week's longest easy run of 16 km+ is the long run.
  if (!days.some((d) => d.kind === "long")) {
    // An easy run of 16 km+, or a run with marathon-pace work of 24 km+ ("32 km, 16 at 3:58").
    const cand = days
      .filter((d) => !d.flex && !/medium/i.test(d.text) && ((d.kind === "easy" && (d.km ?? 0) >= 16) || (d.kind === "key" && (d.km ?? 0) >= 24)))
      .sort((a, b) => (b.km ?? 0) - (a.km ?? 0))[0];
    if (cand) cand.kind = "long";
  }

  // Size the flexible days so the week lands in the middle of its target.
  let plannedKm: number | null = null;
  if (week) {
    const target = week.kmMin != null ? mid(week.kmMin, week.kmMax ?? week.kmMin) : null;
    // "about 35 + race": the target excludes the race itself.
    const plusRace = /\+\s*race/i.test(week.km);
    const fixed = days.reduce((s, d) => s + (d.flex || (plusRace && d.kind === "race") ? 0 : d.km ?? 0), 0);
    // Recovery weeks: keep the filler runs short.
    if (/^R\d/.test(week.week)) for (const d of days) if (d.flex) d.flex = [5, 8];
    const flex = days.filter((d) => d.flex && !d.optional);
    const opt = days.filter((d) => d.flex && d.optional);
    let left = target != null ? target - fixed : flex.reduce((s, d) => s + mid(...d.flex!), 0);
    // Each easy day gets its minimum while there's room (a 5 km run at least), then
    // what's left is spread across them up to their maximum, then the optional days.
    let rem = left;
    for (const d of flex) {
      d.km = rem >= d.flex![0] ? d.flex![0] : rem >= 5 ? rem : 0;
      rem -= d.km;
    }
    const room = flex.filter((d) => d.km).reduce((s, d) => s + d.flex![1] - d.km!, 0);
    if (rem > 0 && room > 0) {
      const f = Math.min(1, rem / room);
      for (const d of flex) if (d.km) d.km += (d.flex![1] - d.km) * f;
      rem -= Math.min(rem, room);
    }
    for (const d of opt) {
      d.km = rem >= 4 ? Math.min(d.flex![1], Math.max(d.flex![0], rem)) : 0;
      rem -= d.km;
    }
    for (const d of days) {
      if (d.km != null) d.km = Math.round(d.km);
      if (d.km === 0 && d.kind !== "race") {
        d.kind = d.kind === "optional" || d.kind === "rest" || d.flex ? "rest" : d.kind;
        if (d.kind === "rest") d.text = "Rest";
      } else if (d.kind === "optional") {
        d.kind = "easy";
        d.text = d.text.replace(/^Rest,?\s*or\s*/i, "");
      }
      d.pace = d.kind === "race" ? d.pace : paceFor(plan, d.text, d.kind);
    }
    plannedKm = days.reduce((s, d) => s + (d.km ?? 0), 0);
  }

  return {
    monday,
    week,
    block,
    days: days.map(({ flex: _f, optional: _o, ...d }) => d),
    plannedKm,
    actualKm: days.reduce((s, d) => s + d.actualKm, 0),
  };
}

/** Mondays from the first plan week (or a few weeks before today) to the last plan week or block. */
export function forecastRange(plan: Plan, today: string): { first: string; last: string } {
  const firstPlan = plan.weeks[0]?.start ?? today;
  const lastBlock = [...plan.blocks].filter((b) => b.end).sort((a, b) => b.end!.localeCompare(a.end!))[0]?.end;
  const lastPlan = plan.weeks[plan.weeks.length - 1]?.start ?? today;
  const first = mondayOf(firstPlan < addDays(today, -56) ? addDays(today, -56) : firstPlan);
  const last = mondayOf(lastBlock && lastBlock > lastPlan ? lastBlock : lastPlan);
  return { first, last };
}

export const isKeyDay = (d: ForecastDay) => d.kind === "key" || d.kind === "long" || d.kind === "race";
export const dayOfMonth = (date: string) => parseKey(date).getDate();

/**
 * Every day of a plan week written out as its own session ("7 km recovery",
 * "10 km easy + 6 × 20 s strides", "Rest"), using the distances the forecast
 * gives the days the plan leaves to the weekly structure. Named days and race
 * days are kept as they are.
 */
export function fullWeekSessions(plan: Plan, week: PlanWeek): PlanWeek["sessions"] {
  const out: PlanWeek["sessions"] = { ...week.sessions };
  const fw = forecastWeek(plan, week.start);
  const crossDay = /\.\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b[^:.]*:/;
  fw.days.forEach((d, i) => {
    const key = WEEK_KEYS[i];
    // A cell that also holds another day's session ("Easy 12 km. Thu: 2 × 5 km at 3:46") keeps only its own part.
    if (out[key] && crossDay.test(out[key]!)) out[key] = d.text;
    if (out[key] || d.race || d.kind === "race") return;
    if (d.kind === "rest" || !d.km) {
      out[key] = "Rest";
      return;
    }
    const t = d.text.trim();
    // Sessions and anything already given in km or minutes are written as the plan has them.
    if (d.kind === "key" || /\d\s*(?:km|min)\b/i.test(t.replace(/\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*km/i, ""))) {
      out[key] = t.replace(/\d+(?:\.\d+)?\s*[–-]\s*\d+(?:\.\d+)?\s*km/i, `${d.km} km`);
      return;
    }
    out[key] = /\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*km/i.test(t)
      ? t.replace(/\d+(?:\.\d+)?(?:\s*[–-]\s*\d+(?:\.\d+)?)?\s*km/i, `${d.km} km`)
      : `${d.km} km ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  });
  return out;
}
