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
    return { week, wk, days, done, history, lastRun, races: upcomingRaces(plan, today).slice(0, 4) };
  }, [plan, runs, today]);

  if (!plan || !view) return <CardHeader title="Running" />;
  const { week, wk, done, history, lastRun, races } = view;
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
      <div className="band-cols run-band-cols">
        <div className="band-col">
          <div className="run-km">
            <span className="num big">{connected ? done.toFixed(1) : "–"}</span>
            <span className="muted"> / {week ? week.km : "–"} km this week</span>
          </div>
          <div className="run-bar" title="This week against the plan">
            {lo != null && hi != null && hi > lo && <span className="run-band" style={{ left: `${(lo / hi) * 100}%` }} />}
            <span className={"run-fill" + (lo != null && done >= lo ? " met" : "")} style={{ width: `${pct * 100}%` }} />
          </div>
          <div className="muted small">{week ? `${phase}${week.notes ? " · " + week.notes : ""}` : "Outside the plan's weeks"}</div>
          <div className="run-today small">
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
          <div className="run-last small">
            <span className="label">Last run</span>{" "}
            {lastRun ? (
              <>
                <span className="num">{km(lastRun.distance).toFixed(1)} km</span> · <span className="num">{pace(lastRun.distance, lastRun.moving_time)}</span>/km
                {lastRun.avg_hr ? (
                  <>
                    {" "}
                    · <span className="num">{Math.round(lastRun.avg_hr)}</span> bpm
                  </>
                ) : null}
                <span className="muted"> · {relativeDayLabel(lastRun.date, today)}</span>
              </>
            ) : (
              <span className="muted">{connected ? "No runs synced yet" : "Connect Strava in Settings"}</span>
            )}
          </div>
        </div>

        <div className="band-col band-grow run-chart">
          <div className="label">Last 12 weeks</div>
          <BarChart bars={history} height={80} unit=" km" />
        </div>

        <div className="band-col run-races">
          <div className="label">Races</div>
          {races.map((r) => (
            <div key={r.name} className="run-race">
              <span className="num run-race-days">{r.days}</span>
              <span className="run-race-name">
                {r.name}
                <span className="small muted">
                  {" "}
                  · {r.approx ? "≈ " : ""}
                  {r.when} · {r.target}
                </span>
              </span>
            </div>
          ))}
        </div>
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
  defaultPos: { x: 0, y: 2, w: 12, h: 5 },
  minW: 5,
  minH: 3,
  migrations,
  Card: RunningCard,
};
