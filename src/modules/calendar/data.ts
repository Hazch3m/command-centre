import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { addDays, dateKey } from "../../core/time";

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

/** Fetches yesterday to 8 days ahead from every shown calendar into the local cache. */
export async function syncCalendar(): Promise<CalSync> {
  const status = await backend.oauthStatus("google").catch(() => null);
  if (!status?.connected) return getCalSync();
  let state: CalSync;
  try {
    const list = await get<{ items: { id: string; summary: string; summaryOverride?: string; backgroundColor: string; primary?: boolean; selected?: boolean }[] }>(
      `${API}/users/me/calendarList?minAccessRole=reader`,
    );
    const known = new Map((await getCalendars()).map((c) => [c.id, c]));
    const cals: CalendarInfo[] = list.items.map((c) => ({
      id: c.id,
      name: c.summaryOverride ?? c.summary,
      color: c.backgroundColor,
      primary: !!c.primary,
      // New calendars follow Google's own "shown in my list" choice.
      show: known.get(c.id)?.show ?? (!!c.primary || !!c.selected),
    }));
    await kvSet("calendar.calendars", cals);

    const now = new Date();
    const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toISOString();
    const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 9).toISOString();
    const statements: { sql: string; params: (string | number | null)[] }[] = [{ sql: "DELETE FROM calendar_events", params: [] }];
    for (const c of cals.filter((x) => x.show)) {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const ev = await get<{ items: GEvent[] }>(`${API}/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const e of ev.items ?? []) {
        if (e.status === "cancelled") continue;
        const allDay = !!e.start.date;
        statements.push({
          sql: "INSERT OR REPLACE INTO calendar_events (id, calendar_id, summary, start, end, all_day, location, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [e.id, c.id, e.summary ?? "(No title)", e.start.date ?? e.start.dateTime!, e.end.date ?? e.end.dateTime!, allDay ? 1 : 0, e.location ?? null, c.color],
        });
      }
    }
    // Replace the cache in one transaction: a failed sync leaves the old data intact.
    await db.batch(statements);
    state = { lastSync: new Date().toISOString(), offline: false, error: null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    state = { ...(await getCalSync()), offline: msg.startsWith("offline"), error: msg.startsWith("offline") ? null : msg };
  }
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
