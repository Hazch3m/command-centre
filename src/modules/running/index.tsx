import { useMemo, useState } from "react";
import { addDays, parseKey, relativeDayLabel, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { mondayOf, planWeekNumber, sessionFor, upcomingRaces, weekFor } from "./plan";
import { RunningPage } from "./RunningPage";
import { km, pace, weekDays, weeklyTotals } from "./stats";
import { migrations } from "./strava";
import { useRunningData, useStravaSync } from "./useRunning";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function shortSession(text: string): string {
  return text.replace(/\s*\(.*?\)\s*/g, " ").replace(/,? \d+ ?(min|s) jog$/, "").trim();
}

function RunningCard({ editing }: CardProps) {
  const today = useToday();
  useStravaSync();
  const { plan, planError, runs, connected, sync } = useRunningData();
  const [open, setOpen] = useState(false);

  const view = useMemo(() => {
    if (!plan) return null;
    const week = weekFor(plan, today);
    const wk = planWeekNumber(plan, today);
    const days = weekDays(runs ?? [], today);
    const done = days.reduce((s, d) => s + d.km, 0);
    const mon = mondayOf(today);
    const history = weeklyTotals(runs ?? [], addDays(mon, -11 * 7), mon).map((w) => {
      const pw = weekFor(plan, w.week);
      return {
        label: String(parseKey(w.week).getDate()),
        value: w.km,
        target: pw?.kmMin ?? null,
        targetMax: pw?.kmMax ?? null,
        highlight: w.week === mon,
        title: `Week of ${relativeDayLabel(w.week, today)}: ${w.km.toFixed(1)} km${pw ? ` (plan ${pw.km})` : ""}`,
      };
    });
    const lastRun = runs?.length ? runs[runs.length - 1] : null;
    return { week, wk, days, done, history, lastRun, races: upcomingRaces(plan, today).slice(0, 3) };
  }, [plan, runs, today]);

  if (!plan || !view) return <CardHeader title="Running" />;
  const { week, wk, days, done, history, lastRun, races } = view;
  const lo = week?.kmMin ?? null;
  const hi = week?.kmMax ?? lo;
  const pct = hi ? Math.min(1, done / hi) : 0;
  const todaySession = sessionFor(plan, today);
  const tomorrowSession = sessionFor(plan, addDays(today, 1));
  // Weeks R1/R2 sit under the "Recovery and Phase 1" heading in the plan.
  const phase = week ? (/^R\d/.test(week.week) ? "Recovery" : week.phase.replace(/\s*\(.*\)$/, "").replace(/^Recovery and /, "")) : "";

  return (
    <>
      <CardHeader
        title="Running"
        right={
          <>
            {wk && (
              <span className="pill" title={phase}>
                Week {wk.label} · {wk.index + 1}/{wk.total}
              </span>
            )}
            <button className="btn" onClick={() => !editing && setOpen(true)}>
              Plan ›
            </button>
          </>
        }
      />
      <ErrorNote error={planError} />
      <div className="run-top">
        <div className="run-volume">
          <div className="run-km">
            <span className="num big">{connected ? done.toFixed(1) : "–"}</span>
            <span className="muted"> / {week ? week.km : "–"} km</span>
          </div>
          <div className="run-bar" title="This week against the plan">
            {lo != null && hi != null && hi > lo && <span className="run-band" style={{ left: `${(lo / hi) * 100}%` }} />}
            <span className={"run-fill" + (lo != null && done >= lo ? " met" : "")} style={{ width: `${pct * 100}%` }} />
          </div>
          <div className="muted small">{week ? `${phase}${week.notes ? " · " + week.notes : ""}` : "Outside the plan's weeks"}</div>
        </div>
        <div className="run-last">
          <div className="label">Last run</div>
          {lastRun ? (
            <>
              <div className="run-last-main">
                <span className="num">{km(lastRun.distance).toFixed(1)} km</span> · <span className="num">{pace(lastRun.distance, lastRun.moving_time)}</span>/km
                {lastRun.avg_hr ? (
                  <>
                    {" "}
                    · <span className="num">{Math.round(lastRun.avg_hr)}</span> bpm
                  </>
                ) : null}
              </div>
              <div className="muted small one-line" title={lastRun.name}>
                {relativeDayLabel(lastRun.date, today)} · {lastRun.name}
              </div>
            </>
          ) : (
            <div className="muted small">{connected ? "No runs synced yet" : "Connect Strava in Settings"}</div>
          )}
        </div>
      </div>

      <div className="run-days">
        {days.map((d, i) => {
          const s = sessionFor(plan, d.date);
          const isToday = d.date === today;
          return (
            <div key={d.date} className={"run-day" + (isToday ? " today" : "") + (d.date < today ? " past" : "") + (s?.key ? " key" : "")} title={s?.text}>
              <div className="run-day-name">{DOW[i]}</div>
              <div className={"run-day-km num" + (d.km ? " ran" : "")}>{d.km ? d.km.toFixed(1) : "·"}</div>
              {s?.key && <div className="run-day-session">{shortSession(s.text)}</div>}
            </div>
          );
        })}
      </div>

      <div className="run-today">
        {todaySession && (
          <div>
            <span className="label">Today</span> {todaySession.text}
          </div>
        )}
        {tomorrowSession && (
          <div className="muted">
            <span className="label">Tomorrow</span> {tomorrowSession.text}
          </div>
        )}
      </div>

      <div className="run-chart">
        <BarChart bars={history} height={90} unit=" km" />
      </div>

      <div className="run-races">
        {races.map((r) => (
          <div key={r.name} className="run-race">
            <span className="num big-ish">{r.days}</span>
            <span className="small muted">{r.days === 1 ? "day" : "days"}</span>
            <span className="run-race-name">{r.name}</span>
            <span className="small muted">
              {r.approx ? "≈ " : ""}
              {r.when} · {r.target}
            </span>
          </div>
        ))}
      </div>
      {sync?.offline && <div className="muted small">Offline — showing runs synced {sync.lastSync ? relativeDayLabel(sync.lastSync.slice(0, 10), today).toLowerCase() : "earlier"}.</div>}
      {sync?.lastError && <ErrorNote error={`Strava: ${sync.lastError}`} />}
      {open && <RunningPage onClose={() => setOpen(false)} />}
    </>
  );
}

export const runningModule: DashboardModule = {
  id: "running",
  title: "Running",
  defaultPos: { x: 0, y: 3, w: 7, h: 11 },
  minW: 5,
  minH: 8,
  migrations,
  Card: RunningCard,
};
