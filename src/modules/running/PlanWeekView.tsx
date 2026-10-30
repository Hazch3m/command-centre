import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { forecastRange, forecastWeek, type ForecastDay, type ForecastWeek } from "./forecast";
import { checkDays } from "./pace";
import { PaceBadge } from "./PaceOnPoint";
import { mondayOf, type Plan } from "./plan";
import { openRun, openWeek } from "./RunView";
import { RUN_TYPE_LABEL, typeOfDay, typeOfRun, type RunType } from "./runType";
import { km, pace } from "./stats";
import { loadDetails, loadOverrides, type Run } from "./strava";
import { DayEditor } from "./WeekCalendar";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const TYPES: RunType[] = ["easy", "long", "speed", "race"];
const phaseName = (p: string) => p.replace(/\s*\(.*\)\s*$/, "").replace(/^Recovery and /, "");

/**
 * The plan one week at a time, days side by side as tiles (like Runna's week
 * view). ‹ › or the arrow keys move between weeks; click a day to change it.
 */
export function PlanWeekView({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const today = useToday();
  const thisMonday = mondayOf(today);
  const range = useMemo(() => forecastRange(plan, today), [plan, today]);
  const [monday, setMonday] = useState(thisMonday);
  useEffect(() => setMonday(thisMonday), [thisMonday]);
  const [dir, setDir] = useState<0 | 1 | -1>(0);
  const version = useDataVersion("running");
  const { data: overrides } = useQuery(loadOverrides, [version]);
  const { data: details } = useQuery(() => loadDetails(addDays(monday, -1)), [version, monday]);
  const [editing, setEditing] = useState<{ d: ForecastDay; week: ForecastWeek } | null>(null);
  const fw = useMemo(() => forecastWeek(plan, monday, runs, overrides), [plan, monday, runs, overrides]);
  const checks = details ? checkDays(fw.days, details) : undefined;
  const go = (n: number) => {
    const m = addDays(monday, 7 * n);
    if (m < range.first || m > range.last) return;
    setDir(n > 0 ? 1 : -1);
    setMonday(m);
  };
  const onKey = (e: KeyboardEvent) => {
    if (editing || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
    if (e.key === "ArrowRight") (go(1), e.preventDefault());
    else if (e.key === "ArrowLeft") (go(-1), e.preventDefault());
    else if (e.key === "Home" || e.key === "t") setMonday(thisMonday);
  };

  const weeks = useMemo(() => {
    const out: { monday: string; label: string; race: boolean }[] = [];
    for (let m = range.first; m <= range.last; m = addDays(m, 7)) {
      const w = plan.weeks.find((x) => x.start <= m && m <= x.end);
      out.push({ monday: m, label: w ? w.week : "·", race: plan.races.some((r) => r.date && r.date >= m && r.date <= addDays(m, 6)) });
    }
    return out;
  }, [plan, range]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".sel")?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [monday]);

  const offset = Math.round((parseKey(monday).getTime() - parseKey(thisMonday).getTime()) / (7 * 86400000));
  const planned = fw.plannedKm;
  const past = addDays(monday, 6) < today;
  const pct = planned ? Math.min(1, fw.actualKm / planned) : 0;
  const idx = fw.week ? plan.weeks.indexOf(fw.week) : -1;
  return (
    <div className="pwv" tabIndex={0} onKeyDown={onKey}>
      <div className="pwv-head">
        <button className="btn icon pwv-arrow" onClick={() => go(-1)} disabled={monday <= range.first} aria-label="Previous week">
          ‹
        </button>
        <div className="pwv-title">
          <div>
            <b>{fw.week ? `Week ${fw.week.week}` : fw.block ? fw.block.name : "No plan this week"}</b>
            {idx >= 0 && <span className="muted"> of {plan.weeks.length}</span>}
            {offset === 0 ? <span className="pw-now">This week</span> : <span className="pwv-when">{offset === 1 ? "Next week" : offset > 0 ? `In ${offset} weeks` : offset === -1 ? "Last week" : `${-offset} weeks ago`}</span>}
          </div>
          <div className="muted small">
            {fmt(monday)} – {fmt(addDays(monday, 6))}
            {fw.week ? ` · ${phaseName(fw.week.phase)}` : ""}
          </div>
        </div>
        <div className="pwv-km">
          <span className="num">
            {offset <= 0 ? <b>{fw.actualKm.toFixed(0)}</b> : null}
            {offset <= 0 ? " / " : ""}
            {planned != null ? `${Math.round(planned)} km` : fw.block ? `${fw.block.km} km` : ""}
          </span>
          {offset <= 0 && planned ? (
            <span className="pw-progress">
              <span style={{ width: `${pct * 100}%` }} className={pct >= 0.9 ? "ok" : pct >= 0.6 || !past ? "mid" : "low"} />
            </span>
          ) : null}
        </div>
        {offset !== 0 && (
          <button className="btn" onClick={() => (setDir(offset > 0 ? -1 : 1), setMonday(thisMonday))}>
            This week
          </button>
        )}
        <button className="btn icon pwv-arrow" onClick={() => go(1)} disabled={monday >= range.last} aria-label="Next week">
          ›
        </button>
      </div>
      {fw.week?.notes && <div className="pwv-notes small">{fw.week.notes}</div>}
      {!fw.week && fw.block && (
        <div className="pwv-notes small">
          Focus: {fw.block.key}
          {fw.block.race ? ` · ${fw.block.race}` : ""}. No day-by-day sessions this far out yet.
        </div>
      )}
      <div className={"pwv-days" + (dir > 0 ? " from-right" : dir < 0 ? " from-left" : "")} key={monday}>
        {fw.days.map((d, i) => {
          const t: RunType = fw.week ? typeOfDay(d.kind) : d.runs.length ? typeOfRun(d.runs[0]) : "rest";
          const isToday = d.date === today;
          const missed = d.date < today && !d.runs.length && t !== "rest" && (d.km ?? 0) > 0;
          return (
            <button
              key={d.date}
              className={`pwv-day rt-${t}` + (isToday ? " today" : "") + (d.date < today ? " past" : "") + (d.runs.length ? " done" : "")}
              onClick={() => (fw.week ? setEditing({ d, week: fw }) : d.runs[0] && openRun(d.runs[0].id))}
              title={fw.week ? "Change this day" : undefined}
            >
              <span className="pwv-day-top">
                <span>
                  <b>{DOW_LONG[i].slice(0, 3)}</b> <span className="muted">{parseKey(d.date).getDate()}</span>
                </span>
                {isToday && <span className="pwv-today">Today</span>}
              </span>
              {fw.week && <span className={`rt-pill rt-${t}`}>{RUN_TYPE_LABEL[t]}</span>}
              {d.km ? <span className="pwv-km-big num">{d.km}<small> km</small></span> : <span className="pwv-km-big muted">{t === "rest" ? "Rest" : ""}</span>}
              <span className="pwv-text">{d.race ? `${d.race.name}${d.race.target ? ` · ${d.race.target}` : ""}` : t === "rest" ? "" : d.text}</span>
              {d.pace && t !== "rest" && <span className="pwv-pace num">{/\d:\d\d/.test(d.pace) ? `${d.pace}/km` : d.pace}</span>}
              <span className="pwv-tags">
                {d.strength && <span className="wk-tag">Strength {d.strength}</span>}
                {d.edited && <span className="wk-tag edited">Changed</span>}
              </span>
              <span className="pwv-done">
                {d.runs.map((r) => (
                  <span
                    key={r.id}
                    className="pwv-run link"
                    role="link"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRun(r.id);
                    }}
                  >
                    ✓ <b className="num">{km(r.distance).toFixed(1)} km</b> <span className="num">{pace(r.distance, r.moving_time)}/km</span>
                    {checks?.get(r.id) && <PaceBadge c={checks.get(r.id)!} />}
                  </span>
                ))}
                {missed && <span className="muted">Not run</span>}
              </span>
            </button>
          );
        })}
      </div>
      <div className="pwv-foot">
        <span className="rt-legend small">
          {TYPES.map((t) => (
            <span key={t}>
              <i className={`rt-swatch rt-${t}`} /> {RUN_TYPE_LABEL[t]}
            </span>
          ))}
        </span>
        <button className="link small" onClick={() => openWeek(monday)}>
          This week's runs in detail ›
        </button>
      </div>
      <div className="pwv-strip" ref={strip}>
        {weeks.map((w) => (
          <button
            key={w.monday}
            className={"pwv-chip" + (w.monday === monday ? " sel" : "") + (w.monday === thisMonday ? " now" : "") + (w.monday < thisMonday ? " past" : "") + (w.race ? " race" : "")}
            onClick={() => (setDir(w.monday > monday ? 1 : -1), setMonday(w.monday))}
            title={fmt(w.monday)}
          >
            {w.label}
          </button>
        ))}
      </div>
      {editing && createPortal(<DayEditor d={editing.d} week={editing.week} plan={plan} onClose={() => setEditing(null)} />, document.body)}
    </div>
  );
}
