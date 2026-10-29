/**
 * A small iCalendar (.ics) reader for calendar feeds such as Google Calendar's
 * "secret address in iCal format". Handles all-day and timed events, time
 * zones, repeating events (RRULE with the common parts), exceptions (EXDATE)
 * and moved or edited occurrences (RECURRENCE-ID).
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  location: string | null;
  allDay: boolean;
  /** All-day: YYYY-MM-DD (end exclusive). Timed: ISO instant (UTC). */
  start: string;
  end: string;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface Stamp {
  /** Wall-clock parts. */
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
  allDay: boolean;
  utc: boolean;
  tz: string | null;
}

interface RawEvent {
  uid: string;
  summary: string;
  location: string | null;
  status: string | null;
  start: Stamp;
  end: Stamp | null;
  duration: number | null; // ms
  rrule: Record<string, string> | null;
  exdates: Stamp[];
  recurrenceId: Stamp | null;
}

// ---- Lines and properties ------------------------------------------------------

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

function parseLine(line: string): Prop | null {
  // NAME;PARAM=a;PARAM2="b:c":value — the first colon outside quotes ends the name part.
  let inQ = false;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ":" && !inQ) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.split(";");
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

const unescapeText = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

function parseStamp(p: Prop): Stamp | null {
  const v = p.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const allDay = p.params.VALUE === "DATE" || !m[4];
  return {
    y: +m[1],
    m: +m[2],
    d: +m[3],
    hh: allDay ? 0 : +m[4],
    mm: allDay ? 0 : +m[5],
    ss: allDay ? 0 : +(m[6] ?? 0),
    allDay,
    utc: !!m[7],
    tz: !allDay && !m[7] ? p.params.TZID ?? null : null,
  };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}

// ---- Time zones ---------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat | null>();
function formatter(tz: string): Intl.DateTimeFormat | null {
  if (!dtfCache.has(tz)) {
    try {
      dtfCache.set(
        tz,
        new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      );
    } catch {
      dtfCache.set(tz, null); // e.g. a Windows zone name from Outlook: fall back to local time
    }
  }
  return dtfCache.get(tz)!;
}

/** Offset (ms) of `tz` from UTC at instant `t`. */
function tzOffset(t: number, f: Intl.DateTimeFormat): number {
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** Instant (ms) for a wall-clock time. */
export function instant(s: Stamp): number {
  if (s.utc) return Date.UTC(s.y, s.m - 1, s.d, s.hh, s.mm, s.ss);
  const f = s.tz ? formatter(s.tz) : null;
  if (!f) return new Date(s.y, s.m - 1, s.d, s.hh, s.mm, s.ss).getTime();
  const guess = Date.UTC(s.y, s.m - 1, s.d, s.hh, s.mm, s.ss);
  let t = guess - tzOffset(guess, f);
  t = guess - tzOffset(t, f); // second pass settles DST changes
  return t;
}

// ---- Dates ----------------------------------------------------------------------

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const keyOf = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
function addDaysYmd(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const withDate = (s: Stamp, y: number, m: number, d: number): Stamp => ({ ...s, y, m, d });
const stampKey = (s: Stamp) => (s.allDay ? keyOf(s.y, s.m, s.d) : String(instant(s)));

/** nth weekday of a month ("2TU" → second Tuesday, "-1FR" → last Friday). */
function nthWeekday(y: number, m: number, wd: number, n: number): number | null {
  const days = daysIn(y, m);
  const hits: number[] = [];
  for (let d = 1; d <= days; d++) if (dow(y, m, d) === wd) hits.push(d);
  const i = n > 0 ? n - 1 : hits.length + n;
  return hits[i] ?? null;
}

/** Occurrence start dates (wall clock) of a repeating event, in order, up to `untilMs`. */
function expand(start: Stamp, rule: Record<string, string>, untilMs: number): Stamp[] {
  const freq = rule.FREQ;
  const interval = Math.max(1, +(rule.INTERVAL ?? 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  let until = untilMs;
  if (rule.UNTIL) {
    const u = parseStamp({ name: "UNTIL", params: {}, value: rule.UNTIL });
    if (u) until = Math.min(until, u.allDay ? Date.UTC(u.y, u.m - 1, u.d, 23, 59, 59) : instant(u));
  }
  const byDay = rule.BYDAY
    ? rule.BYDAY.split(",").map((x) => {
        const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim());
        return m ? { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) } : null;
      }).filter((x): x is { n: number; wd: number } => !!x)
    : [];
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number) : [];
  const out: Stamp[] = [];
  const startMs = instant(start);
  const push = (y: number, m: number, d: number): boolean => {
    const s = withDate(start, y, m, d);
    const t = instant(s);
    if (t < startMs) return true;
    if (t > until || out.length >= count) return false;
    out.push(s);
    return true;
  };
  for (let i = 0, guard = 0; guard < 4000; i++, guard++) {
    // Stop once a whole period starts after the window (a day of slack for time zones).
    const ps =
      freq === "DAILY"
        ? (({ y, m, d }) => Date.UTC(y, m - 1, d))(addDaysYmd(start.y, start.m, start.d, i * interval))
        : freq === "WEEKLY"
          ? (({ y, m, d }) => Date.UTC(y, m - 1, d))(addDaysYmd(start.y, start.m, start.d, -((dow(start.y, start.m, start.d) + 6) % 7) + i * 7 * interval))
          : freq === "MONTHLY"
            ? Date.UTC(start.y, start.m - 1 + i * interval, 1)
            : Date.UTC(start.y + i * interval, 0, 1);
    if (ps - 86400000 > until) break;
    let ok = true;
    if (freq === "DAILY") {
      const { y, m, d } = addDaysYmd(start.y, start.m, start.d, i * interval);
      if (byDay.length && !byDay.some((b) => b.wd === dow(y, m, d))) {
        if (instant(withDate(start, y, m, d)) > until) break;
        continue;
      }
      ok = push(y, m, d);
    } else if (freq === "WEEKLY") {
      // Weeks start on Monday (RFC default WKST=MO).
      const back = (dow(start.y, start.m, start.d) + 6) % 7;
      const monday = addDaysYmd(start.y, start.m, start.d, -back + i * 7 * interval);
      const wds = byDay.length ? byDay.map((b) => b.wd) : [dow(start.y, start.m, start.d)];
      const offsets = wds.map((wd) => (wd + 6) % 7).sort((a, b) => a - b);
      for (const o of offsets) {
        const { y, m, d } = addDaysYmd(monday.y, monday.m, monday.d, o);
        if (!(ok = push(y, m, d))) break;
      }
    } else if (freq === "MONTHLY") {
      const mi = start.m - 1 + i * interval;
      const y = start.y + Math.floor(mi / 12);
      const m = (mi % 12) + 1;
      let days: number[];
      if (byDay.length) days = byDay.map((b) => (b.n ? nthWeekday(y, m, b.wd, b.n) : null)).filter((x): x is number => x != null);
      else if (byMonthDay.length) days = byMonthDay.map((x) => (x < 0 ? daysIn(y, m) + x + 1 : x));
      else days = [start.d];
      for (const d of days.filter((x) => x >= 1 && x <= daysIn(y, m)).sort((a, b) => a - b)) if (!(ok = push(y, m, d))) break;
    } else if (freq === "YEARLY") {
      const y = start.y + i * interval;
      if (start.d <= daysIn(y, start.m)) ok = push(y, start.m, start.d);
    } else {
      push(start.y, start.m, start.d);
      break;
    }
    if (!ok || out.length >= count) break;
  }
  return out;
}

// ---- Public -------------------------------------------------------------------

function readEvents(text: string): RawEvent[] {
  const events: RawEvent[] = [];
  let cur: Partial<RawEvent> & { props?: Prop[] } | null = null;
  let depth = 0; // skip VALARM etc. nested inside events
  for (const line of unfold(text)) {
    if (!line) continue;
    if (line === "BEGIN:VEVENT") {
      cur = { props: [] };
      depth = 0;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("BEGIN:")) {
      depth++;
      continue;
    }
    if (line.startsWith("END:") && depth > 0) {
      depth--;
      continue;
    }
    if (line === "END:VEVENT") {
      const props = cur.props!;
      const get = (n: string) => props.find((p) => p.name === n);
      const start = get("DTSTART") && parseStamp(get("DTSTART")!);
      if (start) {
        const rr = get("RRULE");
        events.push({
          uid: get("UID")?.value ?? Math.random().toString(36).slice(2),
          summary: get("SUMMARY") ? unescapeText(get("SUMMARY")!.value) : "(No title)",
          location: get("LOCATION") ? unescapeText(get("LOCATION")!.value) || null : null,
          status: get("STATUS")?.value.toUpperCase() ?? null,
          start,
          end: get("DTEND") ? parseStamp(get("DTEND")!) : null,
          duration: get("DURATION") ? parseDuration(get("DURATION")!.value) : null,
          rrule: rr ? Object.fromEntries(rr.value.split(";").map((kv) => kv.split("=") as [string, string]).map(([k, v]) => [k.toUpperCase(), v])) : null,
          exdates: props
            .filter((p) => p.name === "EXDATE")
            .flatMap((p) => p.value.split(",").map((v) => parseStamp({ ...p, value: v })))
            .filter((x): x is Stamp => !!x),
          recurrenceId: get("RECURRENCE-ID") ? parseStamp(get("RECURRENCE-ID")!) : null,
        });
      }
      cur = null;
      continue;
    }
    if (depth === 0) {
      const p = parseLine(line);
      if (p) cur.props!.push(p);
    }
  }
  return events;
}

function toOutput(e: RawEvent, s: Stamp): IcsEvent {
  if (s.allDay) {
    let len = 1;
    if (e.end && e.end.allDay) len = Math.max(1, Math.round((Date.UTC(e.end.y, e.end.m - 1, e.end.d) - Date.UTC(e.start.y, e.start.m - 1, e.start.d)) / 86400000));
    else if (e.duration) len = Math.max(1, Math.round(e.duration / 86400000));
    const end = addDaysYmd(s.y, s.m, s.d, len);
    return { uid: `${e.uid}/${keyOf(s.y, s.m, s.d)}`, summary: e.summary, location: e.location, allDay: true, start: keyOf(s.y, s.m, s.d), end: keyOf(end.y, end.m, end.d) };
  }
  const startMs = instant(s);
  const len = e.end ? instant(e.end) - instant(e.start) : e.duration ?? 0;
  return {
    uid: `${e.uid}/${startMs}`,
    summary: e.summary,
    location: e.location,
    allDay: false,
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + Math.max(0, len)).toISOString(),
  };
}

/** Events overlapping [fromMs, toMs), with repeats expanded. */
export function parseIcs(text: string, fromMs: number, toMs: number): IcsEvent[] {
  const raw = readEvents(text);
  const overrides = new Map<string, RawEvent[]>();
  for (const e of raw) if (e.recurrenceId) overrides.set(e.uid, [...(overrides.get(e.uid) ?? []), e]);
  const out: IcsEvent[] = [];
  const overlaps = (x: IcsEvent) => {
    const s = x.allDay ? new Date(`${x.start}T00:00:00`).getTime() : Date.parse(x.start);
    const en = x.allDay ? new Date(`${x.end}T00:00:00`).getTime() : Date.parse(x.end);
    return s < toMs && Math.max(en, s + 1) > fromMs;
  };
  for (const e of raw) {
    if (e.recurrenceId) continue;
    if (e.status === "CANCELLED") continue;
    if (!e.rrule) {
      const o = toOutput(e, e.start);
      if (overlaps(o)) out.push(o);
      continue;
    }
    const skip = new Set(e.exdates.map(stampKey));
    const moved = overrides.get(e.uid) ?? [];
    for (const m of moved) skip.add(stampKey(m.recurrenceId!));
    // Look back far enough that long events that started earlier are still caught.
    for (const s of expand(e.start, e.rrule, toMs)) {
      if (skip.has(stampKey(s))) continue;
      const o = toOutput(e, s);
      if (overlaps(o)) out.push(o);
    }
  }
  for (const list of overrides.values())
    for (const m of list) {
      if (m.status === "CANCELLED") continue;
      const o = toOutput(m, m.start);
      if (overlaps(o)) out.push(o);
    }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Calendar name from the feed (X-WR-CALNAME), if it has one. */
export function icsName(text: string): string | null {
  const m = /^X-WR-CALNAME:(.*)$/m.exec(text.replace(/\r/g, ""));
  return m ? unescapeText(m[1]) : null;
}
