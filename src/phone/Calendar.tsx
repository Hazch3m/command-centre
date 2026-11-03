import { useEffect, useRef, useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useNow, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { hhmm, loadEvents } from "../modules/calendar/data";
import { dayName, Section } from "./common";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Two weeks of days along the top; the chosen day's events underneath. */
export function Calendar() {
  const today = useToday();
  const now = useNow("minute");
  const v = useDataVersion("calendar");
  const start = addDays(today, -2);
  const days = useQuery(() => loadEvents(start, 30), [v, start]).data ?? [];
  const [sel, setSel] = useState(today);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [sel]);
  const day = days.find((d) => d.date === sel);
  const nextBusy = days.filter((d) => d.date > sel && (d.timed.length || d.allDay.length)).slice(0, 3);
  return (
    <div className="p-screen">
      <div className="p-daystrip" ref={strip}>
        {days.map((d) => {
          const n = d.timed.length + d.allDay.length;
          const x = parseKey(d.date);
          return (
            <button key={d.date} className={"p-daychip" + (d.date === sel ? " on" : "") + (d.date === today ? " today" : "")} onClick={() => setSel(d.date)}>
              <span className="p-daychip-dow">{DOW[x.getDay()]}</span>
              <span className="p-daychip-num num">{x.getDate()}</span>
              <span className="p-daychip-dots">{Array.from({ length: Math.min(3, n) }, (_, i) => <i key={i} />)}</span>
            </button>
          );
        })}
      </div>
      <Section title={dayName(sel, today)}>
        {day?.allDay.map((e) => (
          <div key={e.calendar_id + e.id} className="p-row p-event">
            <span className="p-event-bar" style={{ background: e.color ?? "var(--c-calendar)" }} />
            <span className="p-row-main">
              <span className="p-row-title">{e.summary}</span>
              <span className="p-row-sub">All day</span>
            </span>
          </div>
        ))}
        {day?.timed.map((e) => {
          const past = e.endDate < now;
          const live = e.startDate <= now && now < e.endDate;
          return (
            <div key={e.calendar_id + e.id} className={"p-row p-event" + (past ? " past" : "")}>
              <span className="p-event-time num">
                {hhmm(e.startDate)}
                <small>{hhmm(e.endDate)}</small>
              </span>
              <span className="p-event-bar" style={{ background: e.color ?? "var(--c-calendar)" }} />
              <span className="p-row-main">
                <span className="p-row-title">{e.summary}</span>
                {e.location && <span className="p-row-sub">{e.location}</span>}
              </span>
              {live && <span className="p-now">Now</span>}
            </div>
          );
        })}
        {day && !day.timed.length && !day.allDay.length && <div className="p-row p-empty">Nothing on.</div>}
      </Section>
      {nextBusy.map((d) => (
        <Section key={d.date} title={dayName(d.date, today)} className="p-later">
          {[...d.allDay.map((e) => ({ e, t: "All day" })), ...d.timed.map((e) => ({ e, t: `${hhmm(e.startDate)}–${hhmm(e.endDate)}` }))].map(({ e, t }) => (
            <button key={e.calendar_id + e.id} className="p-row p-event p-row-btn" onClick={() => setSel(d.date)}>
              <span className="p-event-bar" style={{ background: e.color ?? "var(--c-calendar)" }} />
              <span className="p-row-main">
                <span className="p-row-title">{e.summary}</span>
                <span className="p-row-sub">{t}</span>
              </span>
            </button>
          ))}
        </Section>
      ))}
      <p className="p-hint center">Add or change events on the PC (Calendar tab); they show here after the next sync.</p>
    </div>
  );
}
