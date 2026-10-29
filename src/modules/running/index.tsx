import { useMemo } from "react";
import { addDays, parseKey, relativeDayLabel, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { mondayOf, planWeekNumber, upcomingRaces, weekFor } from "./plan";
import { RunningPage } from "./RunningPage";
import { forecastWeek } from "./forecast";
import { km, weekDays, weeklyTotals } from "./stats";
import { migrations } from "./strava";
import { useRunningData, useStravaSync } from "./useRunning";

export function shortSession(text: string): string {
  return text.replace(/\s*\(.*?\)\s*/g, " ").replace(/,? \d+ ?(min|s) jog$/, "").trim();
}

function RunningCard({ editing }: CardProps) {
  const today = useToday();
  useStravaSync();
  const { plan, planError, runs, connected, sync } = useRunningData();

  const view = useMemo(() => {
    if (!plan) return null;
    const week = weekFor(plan, today);
    const wk = planWeekNumber(plan, today);
    const done = weekDays(runs ?? [], today).reduce((s, d) => s + d.km, 0);
    const f = forecastWeek(plan, mondayOf(today), runs ?? []);
    const nextF = forecastWeek(plan, mondayOf(addDays(today, 1)), runs ?? []);
    const todayDay = f.days.find((d) => d.date === today) ?? null;
    const tomorrowDay = [...f.days, ...nextF.days].find((d) => d.date === addDays(today, 1)) ?? null;
    const lastRun = runs?.length ? runs[runs.length - 1] : null;
    const mon = mondayOf(today);
    const history = weeklyTotals(runs ?? [], addDays(mon, -9 * 7), mon).map((w) => {
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
    return { week, wk, done, todayDay, tomorrowDay, lastRun, history, races: upcomingRaces(plan, today).slice(0, 2) };
  }, [plan, runs, today]);

  if (!plan || !view) return <CardHeader title="Running" to="running" />;
  const { week, wk, done, todayDay, tomorrowDay, lastRun, history, races } = view;
  const lo = week?.kmMin ?? null;
  const hi = week?.kmMax ?? lo;
  const pct = hi ? Math.min(1, done / hi) : 0;
  const phase = week ? (/^R\d/.test(week.week) ? "Recovery" : week.phase.replace(/\s*\(.*\)$/, "").replace(/^Recovery and /, "")) : "";
  const ranToday = lastRun?.date === today;

  return (
    <>
      <CardHeader
        title="Running"
        to={editing ? undefined : "running"}
        right={
          wk && (
            <span className="pill" title={phase}>
              Week {wk.label} · {phase}
            </span>
          )
        }
      />
      <ErrorNote error={planError} />
      <div className="run-km">
        <span className="num big">{connected ? done.toFixed(1) : "–"}</span>
        <span className="muted"> / {week ? week.km : "–"} km this week</span>
      </div>
      <div className="run-bar" title="This week against the plan">
        {lo != null && hi != null && hi > lo && <span className="run-band" style={{ left: `${(lo / hi) * 100}%` }} />}
        <span className={"run-fill" + (lo != null && done >= lo ? " met" : "")} style={{ width: `${pct * 100}%` }} />
      </div>

      <div className="run-sessions">
        {[
          { label: "Today", d: todayDay, ran: ranToday },
          { label: "Tomorrow", d: tomorrowDay, ran: false },
        ].map(({ label, d, ran }) => (
          <div key={label} className={"run-session" + (d && (d.kind === "key" || d.kind === "long" || d.kind === "race") ? " key" : "")}>
            <span className="label">{label}</span>
            <span className="run-session-text">{d ? d.text || "–" : "–"}</span>
            <span className="run-session-meta muted small">
              {d?.km ? `≈${d.km} km` : ""}
              {d?.pace && d.kind !== "rest" ? `${d.km ? " · " : ""}${/\d:\d\d/.test(d.pace) ? d.pace + "/km" : d.pace}` : ""}
              {d?.strength ? ` · Strength ${d.strength}` : ""}
              {ran && lastRun ? ` · ✓ ran ${km(lastRun.distance).toFixed(1)} km` : ""}
            </span>
          </div>
        ))}
      </div>

      <div className="run-history">
        <div className="label">Last 10 weeks, km</div>
        <BarChart bars={history} height={70} unit=" km" />
      </div>

      <div className="run-races">
        {races.map((r) => (
          <div key={r.name} className="run-race">
            <span className="num run-race-days">{r.days}</span>
            <span className="run-race-name">
              {r.name}
              <span className="small muted"> · {r.target}</span>
            </span>
          </div>
        ))}
      </div>
      {!connected && <div className="muted small">Connect Strava in Settings to track your runs.</div>}
      {sync?.offline && <div className="muted small">Offline — showing runs synced {sync.lastSync ? relativeDayLabel(sync.lastSync.slice(0, 10), today).toLowerCase() : "earlier"}.</div>}
      {sync?.lastError && <ErrorNote error={`Strava: ${sync.lastError}`} />}
    </>
  );
}

export const runningModule: DashboardModule = {
  id: "running",
  title: "Running",
  defaultPos: { x: 0, y: 0, w: 7, h: 9 },
  minW: 4,
  minH: 6,
  migrations,
  Card: RunningCard,
  page: { label: "Training", order: 1, Page: RunningPage },
};
