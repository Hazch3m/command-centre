import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { addDays, dateKey } from "../../core/time";
import { parseIcs } from "./ics";

export interface CalEvent {
  id: string;
  calendar_id: string;
  summary: string;
  start: string; // ISO datetime, or YYYY-MM-DD for all-day
  end: string;
  all_day: number;
  location: string | null;
  color: string | null;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
  primary: boolean;
  show: boolean;
}

export const migrations = [
  `CREATE TABLE calendar_events (
     id TEXT NOT NULL,
     calendar_id TEXT NOT NULL,
     summary TEXT NOT NULL,
     start TEXT NOT NULL,
     end TEXT NOT NULL,
     all_day INTEGER NOT NULL,
     location TEXT,
     color TEXT,
     PRIMARY KEY (calendar_id, id)
   );
   CREATE INDEX calendar_start ON calendar_events(start);`,
];

const TOPIC = "calendar";
const API = "https://www.googleapis.com/calendar/v3";

export interface CalSync {
  lastSync: string | null;
  offline: boolean;
  error: string | null;
}

export const getCalendars = () => kvGet<CalendarInfo[]>("calendar.calendars", []);
export const getCalSync = () => kvGet<CalSync>("calendar.sync", { lastSync: null, offline: false, error: null });

export async function setShown(id: string, show: boolean) {
  const cals = await getCalendars();
  await kvSet("calendar.calendars", cals.map((c) => (c.id === id ? { ...c, show } : c)));
  await syncCalendar();
}

interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  location?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  transparency?: string;
}

async function get<T>(url: string): Promise<T> {
  const r = await backend.apiRequest<T>("google", "GET", url);
  if (r.status !== 200) throw new Error(`Google Calendar answered ${r.status}`);
  return r.body;
}

const FEED_COLOURS = ["#4f9cf0", "#e0a43a", "#46b98a", "#c77ddb", "#e46f6f", "#3fb7c9"];

type Stmt = { sql: string; params: (string | number | null)[] };
const insert = (id: string, cal: string, summary: string, start: string, end: string, allDay: boolean, location: string | null, color: string): Stmt => ({
  sql: "INSERT OR REPLACE INTO calendar_events (id, calendar_id, summary, start, end, all_day, location, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  params: [id, cal, summary, start, end, allDay ? 1 : 0, location, color],
});

/** Is any calendar source set up (Google sign-in or an iCal address)? */
export async function calendarSources() {
  const [google, feeds] = await Promise.all([backend.oauthStatus("google").catch(() => null), backend.icsList().catch(() => [])]);
  return { google: !!google?.connected, feeds };
}

/**
 * Fetches yesterday to 8 days ahead from every shown calendar into the local
 * cache: Google calendars through the API (if signed in) and calendar feeds
 * (secret iCal addresses). A source that fails keeps its cached events.
 */
export async function syncCalendar(): Promise<CalSync> {
  const { google, feeds } = await calendarSources();
  if (!google && !feeds.length) return getCalSync();
  const known = new Map((await getCalendars()).map((c) => [c.id, c]));
  const cals: CalendarInfo[] = [];
  const statements: Stmt[] = [];
  const keep: string[] = []; // calendars whose cached events stay because their fetch failed
  const errors: string[] = [];
  let offline = false;
  const fail = (e: unknown, label: string) => {
    const msg = String((e as Error)?.message ?? e);
    if (msg.startsWith("offline")) offline = true;
    else errors.push(`${label}: ${msg}`);
  };

  const now = new Date();
  // A week back to six weeks ahead, enough for the week and month views.
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 8);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 43);

  if (google) {
    try {
      const list = await get<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor: string; primary?: boolean; selected?: boolean }[] }>(
        `${API}/users/me/calendarList?minAccessRole=reader`,
      );
      const gcals = list.items.map((c) => ({
        id: c.id,
        name: c.summaryOverride ?? c.summary,
        color: c.backgroundColor,
        primary: !!c.primary,
        // New calendars follow Google's own "shown in my list" choice.
        show: known.get(c.id)?.show ?? (!!c.primary || !!c.selected),
      }));
      cals.push(...gcals);
      for (const c of gcals.filter((x) => x.show)) {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "2500" });
        const ev = await get<{ items: GEvent[] }>(`${API}/calendars/${encodeURIComponent(c.id)}/events?${q}`);
        for (const e of ev.items ?? []) {
          if (e.status === "cancelled") continue;
          statements.push(insert(e.id, c.id, e.summary ?? "(No title)", e.start.date ?? e.start.dateTime!, e.end.date ?? e.end.dateTime!, !!e.start.date, e.location ?? null, c.color));
        }
      }
    } catch (e) {
      fail(e, "Google Calendar");
      keep.push(...[...known.values()].filter((c) => !c.id.startsWith("ics:")).map((c) => c.id));
      cals.push(...[...known.values()].filter((c) => !c.id.startsWith("ics:")));
    }
  }

  feeds.forEach((f, i) => {
    const id = `ics:${f.id}`;
    cals.push({ id, name: f.name, color: known.get(id)?.color ?? FEED_COLOURS[i % FEED_COLOURS.length], primary: false, show: known.get(id)?.show ?? true });
  });
  for (const c of cals.filter((x) => x.id.startsWith("ics:"))) {
    if (!c.show) continue;
    try {
      const text = await backend.icsFetch(c.id.slice(4));
      for (const e of parseIcs(text, from.getTime(), to.getTime())) statements.push(insert(e.uid, c.id, e.summary, e.start, e.end, e.allDay, e.location, c.color));
    } catch (e) {
      fail(e, c.name);
      keep.push(c.id);
    }
  }

  await kvSet("calendar.calendars", cals);
  // Replace the cache in one transaction, keeping events of sources that failed.
  const placeholders = keep.map(() => "?").join(",");
  await db.batch([{ sql: keep.length ? `DELETE FROM calendar_events WHERE calendar_id NOT IN (${placeholders})` : "DELETE FROM calendar_events", params: keep }, ...statements]);
  const state: CalSync = {
    lastSync: errors.length || offline ? (await getCalSync()).lastSync ?? null : new Date().toISOString(),
    offline,
    error: errors.length ? errors.join(" · ") : null,
  };
  if (!errors.length && !offline) state.lastSync = new Date().toISOString();
  await kvSet("calendar.sync", state);
  await notifyChanged(TOPIC);
  return state;
}

export interface DayEvents {
  date: string;
  allDay: CalEvent[];
  timed: (CalEvent & { startDate: Date; endDate: Date })[];
}

/** Events grouped by local day, today first, for `days` days. Multi-day events appear on each day. */
export async function loadEvents(today: string, days = 8): Promise<DayEvents[]> {
  const rows = await db.select<CalEvent>("SELECT * FROM calendar_events ORDER BY all_day DESC, start");
  const out: DayEvents[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    const dayStart = new Date(`${d}T00:00:00`);
    const dayEnd = new Date(`${addDays(d, 1)}T00:00:00`);
    const allDay = rows.filter((e) => e.all_day && e.start <= d && d < e.end);
    const timed = rows
      .filter((e) => !e.all_day)
      .map((e) => ({ ...e, startDate: new Date(e.start), endDate: new Date(e.end) }))
      .filter((e) => e.startDate < dayEnd && e.endDate > dayStart)
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    out.push({ date: d, allDay, timed });
  }
  return out;
}

export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
export { dateKey };
