import { SendToWatch } from "../watch/SendToWatch";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import { addDays, parseKey, todayKey, useToday } from "../../core/time";
import { CardHeader } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { forecastRange, forecastWeek, isKeyDay, type ForecastDay, type ForecastWeek } from "./forecast";
import { mondayOf, type Plan } from "./plan";
import { km, pace } from "./stats";
import { loadDetails, loadOverrides, setOverride, type Run, type RunDetail } from "./strava";
import { checkDays, type PaceCheck } from "./pace";
import { PaceBadge } from "./PaceOnPoint";
import { useRunningData, useStravaSync } from "./useRunning";
import { openRun, openWeek } from "./RunView";
import { useDataVersion } from "../../core/events";
import { useQuery } from "../../core/useQuery";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => {
  const x = parseKey(d);
  return `${x.getDate()} ${MON[x.getMonth()]}`;
};
const KIND_LABEL: Record<ForecastDay["kind"], string> = { key: "Key session", long: "Long run", easy: "Easy", optional: "Optional", rest: "Rest", race: "Race" };

function Day({ d, today, onEdit, checks }: { d: ForecastDay; today: string; onEdit?: (d: ForecastDay) => void; checks?: Map<string, PaceCheck> }) {
  const past = d.date < today;
  const isToday = d.date === today;
  return (
    <div className={`wk-day kind-${d.kind}` + (isToday ? " today" : "") + (past ? " past" : "") + (d.edited ? " edited" : "")}>
      {onEdit && (
        <button className="wk-edit" onClick={() => onEdit(d)} title="Change this day" aria-label={`Change ${d.dow} ${d.date}`}>
          ✎
        </button>
      )}
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
        {d.edited && <span className="wk-tag edited">Changed</span>}
      </div>
      {d.runs.length > 0 && (
        <div className="wk-actual">
          {d.runs.map((r: Run) => (
            <button key={r.id} className="link wk-run" onClick={() => openRun(r.id)} title={`${r.name} — laps, splits and charts`}>
              ✓ <span className="num">{km(r.distance).toFixed(1)}</span> km · <span className="num">{pace(r.distance, r.moving_time)}</span>
              {r.avg_hr ? <> · {Math.round(r.avg_hr)}</> : null}
              {checks?.get(r.id) && <PaceBadge c={checks.get(r.id)!} />}
            </button>
          ))}
        </div>
      )}
      {past && !d.runs.length && d.kind !== "rest" && d.km ? <div className="wk-actual muted">not run</div> : null}
    </div>
  );
}

const QUICK = ["Rest", "Easy 8 km", "Easy 10 km + strides", "12 km easy", "Long run 20 km"];

/** Change one day: new text, move it to another day (swap), or go back to the plan. */
export function DayEditor({ d, week, plan, onClose }: { d: ForecastDay; week: ForecastWeek; plan: Plan; onClose: () => void }) {
  const [text, setText] = useState(d.text);
  const [busy, setBusy] = useState(false);
  const original = useMemo(() => forecastWeek(plan, week.monday).days.find((x) => x.date === d.date)?.text ?? "", [plan, week.monday, d.date]);
  useEffect(() => {
    const k = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.then(onClose, () => setBusy(false));
  };
  const swapWith = (other: ForecastDay) =>
    run(Promise.all([setOverride(d.date, other.text || "Rest"), setOverride(other.date, d.text || "Rest")]));
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal day-editor" role="dialog" aria-label={`Change ${d.dow}`}>
        <header className="modal-header">
          <h2>
            {d.dow} {fmt(d.date)}
          </h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="muted small">Plan: {original || "–"}</div>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="Session" autoFocus />
        <div className="quick-row">
          {QUICK.map((q) => (
            <button key={q} className="btn" onClick={() => setText(q)}>
              {q}
            </button>
          ))}
        </div>
        <p className="muted small">
          Write it the way the plan does and the distance is worked out: "12 km easy", "Easy 45 min", "5 × 1 km at 3:20, 2 min jog", "28 km, last 6 at 4:05".
        </p>
        <div className="label">Or swap with another day this week</div>
        <div className="quick-row">
          {week.days
            .filter((x) => x.date !== d.date)
            .map((x) => (
              <button key={x.date} className="btn" disabled={busy} onClick={() => swapWith(x)} title={x.text}>
                ⇄ {x.dow}
              </button>
            ))}
        </div>
        {d.date >= todayKey() && (d.km ?? 0) > 0 && !d.race && (
          <div className="day-editor-watch">
            <span className="label">Garmin watch</span>
            <SendToWatch date={d.date} text={text} />
          </div>
        )}
        <footer className="modal-footer">
          {d.edited && (
            <button className="btn" disabled={busy} onClick={() => run(setOverride(d.date, null))}>
              Back to the plan
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => run(setOverride(d.date, text))}>
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}

function WeekBody({ fw, today, onEdit, details }: { fw: ForecastWeek; today: string; onEdit?: (d: ForecastDay) => void; details?: Map<string, RunDetail> }) {
  const checks = details ? checkDays(fw.days, details) : undefined;
  if (fw.week)
    return (
      <div className="wk-days">
        {fw.days.map((d) => (
          <Day key={d.date} d={d} today={today} onEdit={onEdit} checks={checks} />
        ))}
      </div>
    );
  if (fw.block)
    return (
      <div className="wk-block">
        <div>
          <span className="label">Focus</span> {fw.block.key}
        </div>
        {fw.block.race && (
          <div>
            <span className="label">Race</span> {fw.block.race}
          </div>
        )}
        <div className="muted small">
          {fw.block.name}: {fmt(fw.block.start!)} – {fmt(fw.block.end!)}. The plan doesn't have day-by-day sessions this far out yet; they'll appear here once the doc has them and the
          plan is re-exported.
        </div>
        {fw.days.some((d) => d.runs.length) && (
          <div className="wk-days">
            {fw.days.map((d) => (
              <Day key={d.date} d={d} today={today} onEdit={onEdit} checks={checks} />
            ))}
          </div>
        )}
      </div>
    );
  return <div className="muted small wk-block">No plan for this week.</div>;
}

function WeekHead({ fw, thisMonday }: { fw: ForecastWeek; thisMonday: string }) {
  const offset = Math.round((parseKey(fw.monday).getTime() - parseKey(thisMonday).getTime()) / (7 * 86400000));
  return (
    <div className="wk-subhead small">
      <button className="link wk-title-link" onClick={() => openWeek(fw.monday)} title="See this week's runs">
        <b>{fw.week ? `Week ${fw.week.week}` : fw.block ? fw.block.name : "Outside the plan"}</b>
      </button>
      <span className="muted">
        {" "}
        · {fmt(fw.monday)} – {fmt(addDays(fw.monday, 6))}
        {fw.week ? ` · ${fw.week.km} km` : fw.block ? ` · ${fw.block.km} km/week` : ""}
        {fw.week?.notes ? ` · ${fw.week.notes}` : ""}
      </span>
      <span className="wk-when muted">{offset === 1 ? "next week" : offset > 0 ? `in ${offset} weeks` : offset === 0 ? "this week" : `${-offset} weeks ago`}</span>
    </div>
  );
}

/**
 * The plan as a calendar, one week at a time. Scroll (mouse wheel), arrow keys,
 * the ‹ › buttons or the week strip move between weeks.
 */
export function WeekCalendar({ plan, runs, compact, count = 1 }: { plan: Plan; runs: Run[]; compact?: boolean; count?: number }) {
  const today = useToday();
  const thisMonday = mondayOf(today);
  const range = useMemo(() => forecastRange(plan, today), [plan, today]);
  const [monday, setMonday] = useState(thisMonday);
  useEffect(() => setMonday(thisMonday), [thisMonday]);
  const clamp = (m: string) => (m < range.first ? range.first : m > range.last ? range.last : m);
  const go = (n: number) => setMonday((m) => clamp(addDays(m, 7 * n)));
  const version = useDataVersion("running");
  const { data: overrides } = useQuery(loadOverrides, [version]);
  const { data: details } = useQuery(() => loadDetails(addDays(today, -120)), [version, today]);
  const [editing, setEditing] = useState<{ d: ForecastDay; week: ForecastWeek } | null>(null);
  const shown = useMemo(
    () => Array.from({ length: count }, (_, i) => addDays(monday, 7 * i)).filter((m) => m <= range.last).map((m) => forecastWeek(plan, m, runs, overrides)),
    [plan, monday, runs, count, range.last, overrides],
  );
  const f = shown[0];

  // One week per wheel "notch"; trackpads send many small events, so accumulate.
  const acc = useRef(0);
  const last = useRef(0);
  const onWheel = (e: WheelEvent) => {
    if (editing) return;
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
    // Events from the day editor (a portal) still bubble here through React.
    if (editing || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
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
      out.push({ monday: m, label: w ? w.week : b ? "·" : "", km: w ? w.km.replace(/\s*\+\s*race/, "+").replace(/^about\s*/, "≈") : b ? b.km : "", race });
    }
    return out;
  }, [plan, range]);
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    strip.current?.querySelector(".sel")?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [monday]);

  const strip_ = (
      <div className="wk-strip" ref={strip}>
        {weeks.map((w) => (
          <button
            key={w.monday}
            className={"wk-chip" + (w.monday >= monday && w.monday < addDays(monday, 7 * count) ? " sel" : "") + (w.monday === thisMonday ? " now" : "") + (w.monday < thisMonday ? " past" : "") + (w.race ? " has-race" : "")}
            onClick={() => setMonday(w.monday)}
            title={`Week of ${fmt(w.monday)}${w.km ? ` · ${w.km} km` : ""}${w.race ? " · race" : ""}`}
          >
            <span className="wk-chip-label">{w.label || fmt(w.monday)}</span>
            <span className="wk-chip-km num">{w.km}</span>
          </button>
        ))}
      </div>
      
  );

  const phase = f.week ? (/^R\d/.test(f.week.week) ? "Recovery" : f.week.phase.replace(/\s*\(.*\)$/, "").replace(/^Recovery and /, "")) : f.block?.name ?? "";
  const offset = Math.round((parseKey(monday).getTime() - parseKey(thisMonday).getTime()) / (7 * 86400000));

  return (
    <div className={"wk" + (compact ? " compact" : "")} onWheel={onWheel} onKeyDown={onKey} tabIndex={0}>
      <div className="wk-bar">
        <button className="btn icon" onClick={() => go(-1)} disabled={monday <= range.first} aria-label="Previous week">
          ‹
        </button>
        <div className="wk-title">
          <button className="link wk-title-link" onClick={() => openWeek(monday)} title="See this week's runs">
            <b>{f.week ? `Week ${f.week.week}` : f.block ? f.block.name : "Outside the plan"}</b>
          </button>
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

      {!compact && count > 1 && strip_}
      {shown.map((fw, i) => (
        <div key={fw.monday} className="wk-week">
          {i > 0 && <WeekHead fw={fw} thisMonday={thisMonday} />}
          <WeekBody fw={fw} today={today} details={details} onEdit={compact ? undefined : (d) => setEditing({ d, week: fw })} />
        </div>
      ))}
      {!compact && f.week?.notes && <div className="wk-notes small muted">Note: {f.week.notes}</div>}

      {!compact && count === 1 && strip_}
      {!compact && (
        <div className="wk-legend small muted">
          {(["key", "long", "easy", "race"] as const).map((k) => (
            <span key={k} className={`kind-${k}`}>
              <i /> {KIND_LABEL[k]}
            </span>
          ))}
          <span>≈ km are estimates that add up to the week's target · scroll or use ← → to change week · ✎ on a day to change it</span>
        </div>
      )}
      {editing && createPortal(<DayEditor d={editing.d} week={editing.week} plan={plan} onClose={() => setEditing(null)} />, document.body)}
    </div>
  );
}

function TrainingWeekCard({ editing }: CardProps) {
  useStravaSync();
  const { plan, runs } = useRunningData();
  if (!plan) return <CardHeader title="Training week" to="running" />;
  return (
    <>
      <CardHeader title="Training week" to={editing ? undefined : "running"} />
      <WeekCalendar plan={plan} runs={runs ?? []} compact />
    </>
  );
}

export const trainingWeekModule: DashboardModule = {
  id: "training-week",
  title: "Training week",
  defaultPos: { x: 0, y: 9, w: 12, h: 7 },
  minW: 6,
  minH: 5,
  Card: TrainingWeekCard,
};
