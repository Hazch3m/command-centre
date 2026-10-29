import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { backend } from "@backend";
import { addDays, parseKey, useToday } from "../../core/time";
import { CardHeader } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { forecastRange, forecastWeek, isKeyDay, type ForecastDay } from "./forecast";
import { mondayOf, type Plan } from "./plan";
import { RunningPage } from "./RunningPage";
import { km, pace } from "./stats";
import type { Run } from "./strava";
import { useRunningData, useStravaSync } from "./useRunning";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => {
  const x = parseKey(d);
  return `${x.getDate()} ${MON[x.getMonth()]}`;
};
const KIND_LABEL: Record<ForecastDay["kind"], string> = { key: "Key session", long: "Long run", easy: "Easy", optional: "Optional", rest: "Rest", race: "Race" };

function Day({ d, today }: { d: ForecastDay; today: string }) {
  const past = d.date < today;
  const isToday = d.date === today;
  return (
    <div className={`wk-day kind-${d.kind}` + (isToday ? " today" : "") + (past ? " past" : "")}>
      <div className="wk-day-head">
        <span className="wk-dow">{d.dow}</span>
        <span className="wk-date muted">{parseKey(d.date).getDate()}</span>
        {d.km != null && d.km > 0 && <span className="wk-km num">≈{d.km} km</span>}
      </div>
      <div className={"wk-text" + (isKeyDay(d) ? " key" : "")} title={d.text}>
        {d.kind === "race" && <span className="wk-tag race">Race</span>}
        {d.text || <span className="muted">–</span>}
      </div>
      <div className="wk-foot">
        {d.pace && d.kind !== "rest" && <span className="wk-pace num">{/\d:\d\d/.test(d.pace) ? `${d.pace}/km` : d.pace}</span>}
        {d.strength && <span className="wk-tag">Strength {d.strength}</span>}
      </div>
      {d.runs.length > 0 && (
        <div className="wk-actual">
          {d.runs.map((r: Run) => (
            <button key={r.id} className="link wk-run" onClick={() => backend.openStravaActivity(r.id)} title={`${r.name} — open in Strava`}>
              ✓ <span className="num">{km(r.distance).toFixed(1)}</span> km · <span className="num">{pace(r.distance, r.moving_time)}</span>
              {r.avg_hr ? <> · {Math.round(r.avg_hr)}</> : null}
            </button>
          ))}
        </div>
      )}
      {past && !d.runs.length && d.kind !== "rest" && d.km ? <div className="wk-actual muted">missed</div> : null}
    </div>
  );
}

/**
 * The plan as a calendar, one week at a time. Scroll (mouse wheel), arrow keys,
 * the ‹ › buttons or the week strip move between weeks.
 */
export function WeekCalendar({ plan, runs, compact }: { plan: Plan; runs: Run[]; compact?: boolean }) {
  const today = useToday();
  const thisMonday = mondayOf(today);
  const range = useMemo(() => forecastRange(plan, today), [plan, today]);
  const [monday, setMonday] = useState(thisMonday);
  useEffect(() => setMonday(thisMonday), [thisMonday]);
  const clamp = (m: string) => (m < range.first ? range.first : m > range.last ? range.last : m);
  const go = (n: number) => setMonday((m) => clamp(addDays(m, 7 * n)));
  const f = useMemo(() => forecastWeek(plan, monday, runs), [plan, monday, runs]);

  // One week per wheel "notch"; trackpads send many small events, so accumulate.
  const acc = useRef(0);
  const last = useRef(0);
  const onWheel = (e: WheelEvent) => {
    const now = Date.now();
    if (now - last.current > 400) acc.current = 0;
    last.current = now;
    acc.current += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(acc.current) >= 60) {
      go(acc.current > 0 ? 1 : -1);
      acc.current = 0;
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") (go(1), e.preventDefault());
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") (go(-1), e.preventDefault());
    else if (e.key === "Home" || e.key === "t") setMonday(thisMonday);
  };

  const weeks = useMemo(() => {
    const out: { monday: string; label: string; km: string; race: boolean }[] = [];
    for (let m = range.first; m <= range.last; m = addDays(m, 7)) {
      const w = plan.weeks.find((x) => x.start <= m && m <= x.end);
      const b = w ? null : plan.blocks.find((x) => x.start && x.end && x.start <= addDays(m, 6) && m <= x.end);
      const race = plan.races.some((r) => r.date && r.date >= m && r.date <= addDays(m, 6));
      out.push({ monday: m, label: w ? w.week : b ? "·" : "", km: w ? w.km.replace(/\s*\+\s*race/, "+") : b ? b.km : "", race });
    }
    return out;
  }, [plan, range]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [monday]);

  const phase = f.week ? (/^R\d/.test(f.week.week) ? "Recovery" : f.week.phase.replace(/\s*\(.*\)$/, "").replace(/^Recovery and /, "")) : f.block?.name ?? "";
  const offset = Math.round((parseKey(monday).getTime() - parseKey(thisMonday).getTime()) / (7 * 86400000));

  return (
    <div className={"wk" + (compact ? " compact" : "")} onWheel={onWheel} onKeyDown={onKey} tabIndex={0}>
      <div className="wk-bar">
        <button className="btn icon" onClick={() => go(-1)} disabled={monday <= range.first} aria-label="Previous week">
          ‹
        </button>
        <div className="wk-title">
          <b>{f.week ? `Week ${f.week.week}` : f.block ? f.block.name : "Outside the plan"}</b>
          <span className="muted">
            {" "}
            · {fmt(monday)} – {fmt(addDays(monday, 6))}
            {phase && f.week ? ` · ${phase}` : ""}
          </span>
          <span className="wk-when muted small">{offset === 0 ? "this week" : offset === 1 ? "next week" : offset === -1 ? "last week" : offset > 0 ? `in ${offset} weeks` : `${-offset} weeks ago`}</span>
        </div>
        <div className="wk-totals small">
          {f.week && (
            <>
              <span>
                Plan <b className="num">{f.week.km}</b> km
              </span>
              {f.plannedKm != null && <span className="muted">· days add to ≈{Math.round(f.plannedKm)}</span>}
            </>
          )}
          {f.block && <span>{f.block.km} km/week</span>}
          {monday <= thisMonday && (
            <span>
              · ran <b className="num">{f.actualKm.toFixed(1)}</b>
            </span>
          )}
        </div>
        {monday !== thisMonday && (
          <button className="btn" onClick={() => setMonday(thisMonday)}>
            This week
          </button>
        )}
        <button className="btn icon" onClick={() => go(1)} disabled={monday >= range.last} aria-label="Next week">
          ›
        </button>
      </div>

      {f.week ? (
        <div className="wk-days">
          {f.days.map((d) => (
            <Day key={d.date} d={d} today={today} />
          ))}
        </div>
      ) : f.block ? (
        <div className="wk-block">
          <div>
            <span className="label">Focus</span> {f.block.key}
          </div>
          {f.block.race && (
            <div>
              <span className="label">Race</span> {f.block.race}
            </div>
          )}
          <div className="muted small">
            {f.block.name}: {fmt(f.block.start!)} – {fmt(f.block.end!)}. The plan doesn't have day-by-day sessions this far out yet; they'll appear here once the doc has them and
            the plan is re-exported.
          </div>
          {f.days.some((d) => d.runs.length) && (
            <div className="wk-days">
              {f.days.map((d) => (
                <Day key={d.date} d={d} today={today} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="muted small wk-block">No plan for this week.</div>
      )}

      {!compact && f.week?.notes && <div className="wk-notes small muted">Note: {f.week.notes}</div>}

      <div className="wk-strip" ref={strip}>
        {weeks.map((w) => (
          <button
            key={w.monday}
            className={"wk-chip" + (w.monday === monday ? " sel" : "") + (w.monday === thisMonday ? " now" : "") + (w.monday < thisMonday ? " past" : "") + (w.race ? " has-race" : "")}
            onClick={() => setMonday(w.monday)}
            title={`Week of ${fmt(w.monday)}${w.km ? ` · ${w.km} km` : ""}${w.race ? " · race" : ""}`}
          >
            <span className="wk-chip-label">{w.label || fmt(w.monday)}</span>
            <span className="wk-chip-km num">{w.km}</span>
          </button>
        ))}
      </div>
      {!compact && (
        <div className="wk-legend small muted">
          {(["key", "long", "easy", "race"] as const).map((k) => (
            <span key={k} className={`kind-${k}`}>
              <i /> {KIND_LABEL[k]}
            </span>
          ))}
          <span>≈ km are estimates that add up to the week's target · scroll or use ← → to change week</span>
        </div>
      )}
    </div>
  );
}

function TrainingWeekCard({ editing }: CardProps) {
  useStravaSync();
  const { plan, runs } = useRunningData();
  const [open, setOpen] = useState(false);
  if (!plan) return <CardHeader title="Training calendar" />;
  return (
    <>
      <CardHeader
        title="Training calendar"
        right={
          <button className="btn" onClick={() => !editing && setOpen(true)}>
            Full plan ›
          </button>
        }
      />
      <WeekCalendar plan={plan} runs={runs ?? []} />
      {open && <RunningPage onClose={() => setOpen(false)} />}
    </>
  );
}

export const trainingWeekModule: DashboardModule = {
  id: "training-week",
  title: "Training calendar",
  defaultPos: { x: 0, y: 7, w: 12, h: 7 },
  minW: 6,
  minH: 4,
  Card: TrainingWeekCard,
};
