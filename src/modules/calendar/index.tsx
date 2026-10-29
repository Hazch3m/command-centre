import { useEffect, useState } from "react";
import { useDataVersion } from "../../core/events";
import { dateKey, diffDays, relativeDayLabel, useEvery, useNow } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { CalendarFeeds } from "./Connect";
import { calendarSources, getCalendars, getCalSync, hhmm, loadEvents, migrations, setShown, syncCalendar, type DayEvents } from "./data";

function untilLabel(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  return `in ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

function Day({ day, now, today }: { day: DayEvents; now: Date; today: string }) {
  const isToday = day.date === today;
  const visible = isToday ? day.timed.filter((e) => e.endDate > now) : day.timed;
  if (!isToday && !day.allDay.length && !day.timed.length) return null;
  const done = isToday ? day.timed.length - visible.length : 0;
  return (
    <section className={"cal-day" + (isToday ? " today" : "")}>
      <h3>
        {isToday ? "Today" : relativeDayLabel(day.date, today)}
        {done > 0 && <span className="muted small"> · {done} earlier</span>}
      </h3>
      {day.allDay.map((e) => (
        <div key={e.calendar_id + e.id} className="cal-allday" style={{ borderColor: e.color ?? undefined }}>
          {e.summary}
        </div>
      ))}
      <ul>
        {visible.map((e) => {
          const current = e.startDate <= now && now < e.endDate;
          const progress = current ? (now.getTime() - e.startDate.getTime()) / (e.endDate.getTime() - e.startDate.getTime()) : 0;
          const startsToday = dateKey(e.startDate) === day.date;
          return (
            <li key={e.calendar_id + e.id} className={"cal-event" + (current ? " current" : "")}>
              <span className="cal-bar" style={{ background: e.color ?? "var(--info)" }} />
              <span className="cal-time num">
                {startsToday ? hhmm(e.startDate) : "…"}
                <span className="muted"> – {dateKey(e.endDate) === day.date ? hhmm(e.endDate) : "…"}</span>
              </span>
              <span className="cal-main">
                <span className="cal-title">{e.summary}</span>
                {(current || (isToday && e.startDate > now) || e.location) && (
                  <span className="cal-meta muted small">
                    {current ? `Now · ends ${untilLabel(e.endDate.getTime() - now.getTime())}` : isToday ? untilLabel(e.startDate.getTime() - now.getTime()) : ""}
                    {e.location ? `${current || isToday ? " · " : ""}${e.location}` : ""}
                  </span>
                )}
                {current && (
                  <span className="cal-progress">
                    <span style={{ width: `${progress * 100}%` }} />
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {isToday && !visible.length && !day.allDay.length && <div className="muted small">Nothing else today.</div>}
    </section>
  );
}

function CalendarCard({ variant }: CardProps) {
  const now = useNow("minute");
  const today = dateKey(now);
  const version = useDataVersion("calendar");
  useEvery(10 * 60_000, () => {
    syncCalendar().catch(() => {});
  });
  const { data } = useQuery(
    () => Promise.all([loadEvents(today), getCalendars(), getCalSync(), calendarSources().then((s) => ({ connected: s.google || s.feeds.length > 0 }))]),
    [today, version],
  );
  const [choosing, setChoosing] = useState(false);
  const [days, cals, sync, status] = data ?? [[], [], null, null];

  // Re-read when the window regains focus (e.g. after connecting in Settings).
  useEffect(() => {
    const f = () => syncCalendar().catch(() => {});
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, []);

  // Just connected in Settings: fetch straight away.
  const connected = !!status?.connected;
  useEffect(() => {
    if (connected) syncCalendar().catch(() => {});
  }, [connected]);

  const todayEvents = days[0]?.timed ?? [];
  const next = todayEvents.find((e) => e.startDate > now);
  return (
    <>
      <CardHeader
        title="Calendar"
        to="calendar"
        right={
          <>
            {next && <span className="pill">Next {untilLabel(next.startDate.getTime() - now.getTime())}</span>}
            {status?.connected && (
              <button className="btn icon ghost" onClick={() => setChoosing((c) => !c)} aria-label="Choose calendars" title="Choose calendars">
                ✎
              </button>
            )}
          </>
        }
      />
      {data && !status?.connected && (
        <div className="card-scroll">
          <p className="cal-connect-lead">Connect your Google Calendar in four steps:</p>
          <CalendarFeeds />
        </div>
      )}
      {choosing && (
        <div className="cal-choose">
          {cals.map((c) => (
            <label key={c.id} className="inline">
              <input type="checkbox" checked={c.show} onChange={(e) => setShown(c.id, e.target.checked)} />
              <span className="dot" style={{ background: c.color }} />
              {c.name}
            </label>
          ))}
          <div className="label" style={{ marginTop: "0.6rem" }}>
            Add a calendar
          </div>
          <CalendarFeeds intro={false} />
          <button className="btn" onClick={() => setChoosing(false)}>
            Done
          </button>
        </div>
      )}
      {status?.connected && !choosing && (
        <div className={"card-scroll " + (variant === "page" ? "cal-days" : "cal-list")}>
          {days.map((d) => (
            <Day key={d.date} day={d} now={now} today={today} />
          ))}
          {days.slice(1).every((d) => !d.allDay.length && !d.timed.length) && <div className="muted small">Nothing in the next 7 days.</div>}
        </div>
      )}
      {sync?.offline && sync.lastSync && (
        <div className="muted small">Offline — showing events from {diffDays(sync.lastSync.slice(0, 10), today) === 0 ? hhmm(new Date(sync.lastSync)) : relativeDayLabel(sync.lastSync.slice(0, 10), today).toLowerCase()}.</div>
      )}
      {sync?.error && <ErrorNote error={sync.error} />}
    </>
  );
}

export const calendarModule: DashboardModule = {
  id: "calendar",
  title: "Calendar",
  defaultPos: { x: 0, y: 16, w: 6, h: 16 },
  minW: 3,
  minH: 3,
  migrations,
  page: { label: "Calendar", order: 3 },
  Card: CalendarCard,
};
