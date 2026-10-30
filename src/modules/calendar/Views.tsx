import { addDays, dateKey, parseKey } from "../../core/time";
import { hhmm, type DayEvents } from "./data";

export type CalView = "list" | "day" | "week" | "month";
export const VIEWS: { id: CalView; label: string }[] = [
  { id: "list", label: "Agenda" },
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
];

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Monday of the week containing `d`. */
export const weekStart = (d: string) => addDays(d, -((parseKey(d).getDay() + 6) % 7));
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
/** First Monday on or before the 1st, so the month grid starts on a Monday. */
export const monthGridStart = (d: string) => weekStart(monthStart(d));

export function rangeFor(view: CalView, anchor: string): { start: string; days: number; title: string } {
  const x = parseKey(anchor);
  if (view === "day") return { start: anchor, days: 1, title: `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][x.getDay()]} ${x.getDate()} ${MON[x.getMonth()]}` };
  if (view === "week") {
    const s = weekStart(anchor);
    const e = parseKey(addDays(s, 6));
    const a = parseKey(s);
    return { start: s, days: 7, title: `${a.getDate()} ${MON[a.getMonth()].slice(0, 3)} – ${e.getDate()} ${MON[e.getMonth()].slice(0, 3)}` };
  }
  if (view === "month") return { start: monthGridStart(anchor), days: 42, title: `${MON[x.getMonth()]} ${x.getFullYear()}` };
  return { start: anchor, days: 8, title: "" };
}

export function step(view: CalView, anchor: string, n: number): string {
  if (view === "day") return addDays(anchor, n);
  if (view === "week") return addDays(anchor, 7 * n);
  if (view === "month") {
    const x = parseKey(monthStart(anchor));
    return dateKey(new Date(x.getFullYear(), x.getMonth() + n, 1));
  }
  return anchor;
}

const minutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Events of one day laid out on an hour grid, side by side when they overlap. */
function TimeColumn({ day, now, from, to }: { day: DayEvents; now: Date; from: number; to: number }) {
  const span = to - from;
  const dayStart = parseKey(day.date).getTime();
  const evs = day.timed.map((e) => {
    const s = Math.max(from, Math.round((e.startDate.getTime() - dayStart) / 60000));
    const en = Math.min(to, Math.round((e.endDate.getTime() - dayStart) / 60000));
    return { e, s, en: Math.max(en, s + 20) };
  });
  // Simple overlap columns.
  const cols: number[] = [];
  const placed = evs
    .sort((a, b) => a.s - b.s)
    .map((v) => {
      let c = cols.findIndex((end) => end <= v.s);
      if (c < 0) {
        c = cols.length;
        cols.push(v.en);
      } else cols[c] = v.en;
      return { ...v, c };
    });
  const n = Math.max(1, cols.length);
  const nowMin = dateKey(now) === day.date ? minutes(now) : null;
  return (
    <div className="cal-col">
      {placed.map(({ e, s, en, c }) => (
        <div
          key={e.calendar_id + e.id}
          className={"cal-block" + (e.endDate < now ? " past" : "")}
          style={{ top: `${((s - from) / span) * 100}%`, height: `${((en - s) / span) * 100}%`, left: `${(c / n) * 100}%`, width: `${100 / n}%`, borderColor: e.color ?? "var(--info)" }}
          title={`${hhmm(e.startDate)}–${hhmm(e.endDate)} ${e.summary}${e.location ? ` · ${e.location}` : ""}`}
        >
          <span className="cal-block-time num">{hhmm(e.startDate)}</span> <span className="cal-block-title">{e.summary}</span>
        </div>
      ))}
      {nowMin != null && nowMin >= from && nowMin <= to && <div className="cal-now" style={{ top: `${((nowMin - from) / span) * 100}%` }} />}
    </div>
  );
}

function hoursFor(days: DayEvents[]) {
  let from = 7 * 60;
  let to = 21 * 60;
  for (const d of days)
    for (const e of d.timed) {
      const ds = parseKey(d.date).getTime();
      from = Math.min(from, Math.max(0, Math.floor((e.startDate.getTime() - ds) / 3600000)) * 60);
      to = Math.max(to, Math.min(24, Math.ceil((e.endDate.getTime() - ds) / 3600000)) * 60);
    }
  return { from, to };
}

export function TimeGrid({ days, now, today }: { days: DayEvents[]; now: Date; today: string }) {
  const { from, to } = hoursFor(days);
  const hours: number[] = [];
  for (let h = from / 60; h < to / 60; h++) hours.push(h);
  return (
    <div className="cal-grid-wrap">
      {days.length > 1 && (
        <div className="cal-grid-head" style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}>
          <span />
          {days.map((d, i) => (
            <span key={d.date} className={d.date === today ? "today" : ""}>
              {DOW[i]} <b>{parseKey(d.date).getDate()}</b>
            </span>
          ))}
        </div>
      )}
      {days.some((d) => d.allDay.length) && (
        <div className="cal-grid-allday" style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}>
          <span className="muted small">all day</span>
          {days.map((d) => (
            <span key={d.date}>
              {d.allDay.map((e) => (
                <span key={e.calendar_id + e.id} className="cal-allday" style={{ borderColor: e.color ?? undefined }}>
                  {e.summary}
                </span>
              ))}
            </span>
          ))}
        </div>
      )}
      <div className="cal-grid" style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}>
        <div className="cal-hours">
          {hours.map((h) => (
            <span key={h} style={{ top: `${((h * 60 - from) / (to - from)) * 100}%` }}>
              {String(h).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((d) => (
          <div key={d.date} className={"cal-day-col" + (d.date === today ? " today" : "")} style={{ backgroundSize: `100% ${100 / hours.length}%` }}>
            <TimeColumn day={d} now={now} from={from} to={to} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function MonthGrid({ days, anchor, today, onPick }: { days: DayEvents[]; anchor: string; today: string; onPick: (d: string) => void }) {
  const month = anchor.slice(0, 7);
  return (
    <div className="cal-month">
      {DOW.map((d) => (
        <span key={d} className="cal-month-dow">
          {d}
        </span>
      ))}
      {days.map((d) => {
        const all = [...d.allDay.map((e) => ({ key: e.calendar_id + e.id, t: e.summary, c: e.color, time: "" })), ...d.timed.map((e) => ({ key: e.calendar_id + e.id, t: e.summary, c: e.color, time: hhmm(e.startDate) }))];
        return (
          <button key={d.date} className={"cal-month-day" + (d.date.slice(0, 7) !== month ? " other" : "") + (d.date === today ? " today" : "")} onClick={() => onPick(d.date)}>
            <span className="cal-month-num">{parseKey(d.date).getDate()}</span>
            {all.slice(0, 3).map((e) => (
              <span key={e.key} className="cal-month-ev" style={{ borderColor: e.c ?? "var(--info)" }}>
                {e.time && <span className="num">{e.time} </span>}
                {e.t}
              </span>
            ))}
            {all.length > 3 && <span className="muted cal-month-more">+{all.length - 3} more</span>}
          </button>
        );
      })}
    </div>
  );
}
