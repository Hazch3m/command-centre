import { addDays, relativeDayLabel, useToday } from "../../core/time";
import { LineChart, type LineSeries } from "../../shell/charts";
import { CardHeader, Empty } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { fmtVo2, useFitness, type Fitness } from "./fitness";
import { duration } from "./stats";
import { useRunningData, useStravaSync } from "./useRunning";
import { judge, type TrendStatus } from "./vo2";

export const STATUS_LABEL: Record<TrendStatus, string> = { ahead: "Ahead of plan", "on-track": "On track", behind: "Behind plan", "no-data": "No key run yet" };
export const STATUS_CLASS: Record<TrendStatus, string> = { ahead: "status-on-track", "on-track": "status-on-track", behind: "status-behind", "no-data": "status-pending" };
export const LOAD_LABEL = { low: "Low", optimal: "Optimal", high: "High", "very-high": "Very high" } as const;

/** Chart series shared by the card and the full page. */
export function vo2Series(f: Fitness, from: string, to: string): LineSeries[] {
  const proj: LineSeries["points"] = [];
  if (f.start) {
    const end = [...f.config.projection.milestones].sort((a, b) => b.date.localeCompare(a.date))[0]?.date ?? to;
    for (let d = f.start.date; d <= end && d <= to; d = addDays(d, 7)) proj.push({ x: d, y: f.project(d) });
    for (const m of f.config.projection.milestones) if (m.date <= to) proj.push({ x: m.date, y: m.vo2 });
    proj.sort((a, b) => a.x.localeCompare(b.x));
  }
  return [
    { name: "Key run", kind: "dots", className: "s-est", points: f.estimates.filter((e) => e.date >= from).map((e) => ({ x: e.date, y: e.vo2, label: e.name })) },
    { name: "Trend", kind: "line", className: "s-trend", points: f.weekly.filter((w) => w.week >= from).map((w) => ({ x: addDays(w.week, 3), y: w.smooth })) },
    { name: "Plan", kind: "dashed", className: "s-proj", points: proj },
    { name: "Garmin", kind: "dots", className: "s-garmin", points: f.readings.map((r) => ({ x: r.date, y: r.vo2 })) },
    { name: "Race", kind: "diamonds", className: "s-race", points: f.races.filter((r) => r.date >= from).map((r) => ({ x: r.date, y: r.vdot, label: r.name })) },
  ];
}

export function Legend({ garmin }: { garmin: boolean }) {
  return (
    <div className="legend">
      <span>
        <i className="l-est" />
        Key runs &amp; trend
      </span>
      <span>
        <i className="l-proj" />
        Plan to goal
      </span>
      <span>
        <i className="l-race" />
        Races (VDOT)
      </span>
      {garmin && (
        <span>
          <i className="l-garmin" />
          Garmin
        </span>
      )}
    </div>
  );
}

function FitnessCard(_: CardProps) {
  const today = useToday();
  useStravaSync();
  const { plan, connected } = useRunningData();
  const f = useFitness(plan);
  if (!f) return <CardHeader title="Fitness" />;
  if (!f.estimates.length)
    return (
      <>
        <CardHeader title="Fitness" />
        <Empty>
          {connected
            ? "Reading your runs' heart-rate splits from Strava. VO2 max appears once a few key runs are in (this backfills over the first hour or so)."
            : "Connect Strava in Settings to estimate VO2 max from your key runs."}
        </Empty>
      </>
    );
  const from = addDays(today, -18 * 7);
  const to = f.nextMilestone?.date ?? addDays(today, 26 * 7);
  const projNow = f.project(today);
  const thisWeekRuns = f.weekly[f.weekly.length - 1]?.runs ?? [];
  const lastWeekRuns = f.weekly[f.weekly.length - 2]?.runs ?? [];
  const keyRuns = thisWeekRuns.length ? thisWeekRuns : lastWeekRuns;
  return (
    <>
      <CardHeader
        title="Fitness"
        right={
          <>
            <span className={`status ${STATUS_CLASS[f.thisWeek.status]}`} title={`Week of ${f.thisWeek.week}`}>
              {STATUS_LABEL[f.thisWeek.status]}
            </span>
            {f.load.status && (
              <span className={"pill" + (f.load.status === "very-high" ? " pill-danger" : f.load.status === "optimal" ? " pill-accent" : "")} title="Acute (7-day) ÷ chronic (28-day) training load">
                Load {f.load.ratio!.toFixed(2)} · {LOAD_LABEL[f.load.status]}
              </span>
            )}
          </>
        }
      />
      <div className="fit-top">
        <div>
          <div className="num fit-big">{fmtVo2(f.current)}</div>
          <div className="muted small">VO2 max · {f.calibration === "garmin" ? "Garmin scale" : f.calibration === "races" ? "race scale" : "estimate"}</div>
        </div>
        <div className="fit-facts small">
          <div>
            <span className="label">Plan now</span> <span className="num">{fmtVo2(projNow)}</span>
            {f.current != null && projNow != null && (
              <span className={f.current - projNow >= -1 ? "tone-accent" : "tone-danger"}>
                {" "}
                ({f.current - projNow >= 0 ? "+" : ""}
                {(f.current - projNow).toFixed(1)})
              </span>
            )}
          </div>
          <div>
            <span className="label">Trend</span> {f.slope == null ? "–" : `${f.slope >= 0 ? "+" : ""}${f.slope.toFixed(2)}/week`}
            {f.neededSlope != null && <span className="muted"> · need {f.neededSlope >= 0 ? "+" : ""}{f.neededSlope.toFixed(2)}</span>}
          </div>
          {f.nextMilestone && (
            <div className="muted">
              Goal {f.nextMilestone.vo2.toFixed(1)} by {relativeDayLabel(f.nextMilestone.date, today)} ({f.nextMilestone.label})
            </div>
          )}
        </div>
      </div>
      <LineChart series={vo2Series(f, from, to)} from={from} to={to} height={130} today={today} markers={f.config.projection.milestones.map((m) => ({ x: m.date, label: m.label.split(" · ")[0] }))} />
      <div className="fit-keyruns small">
        <span className="label">{thisWeekRuns.length ? "This week" : "Last week"}</span>
        {keyRuns.length ? (
          keyRuns.map((k) => {
            const st = judge(k.vo2, f.project(k.date) ?? k.vo2);
            return (
              <span key={k.id} className="fit-keyrun" title={k.name}>
                {relativeDayLabel(k.date, today)} <span className="num">{k.vo2.toFixed(1)}</span>{" "}
                <span className={st === "behind" ? "tone-danger" : "tone-accent"}>{st === "behind" ? "▼" : "✓"}</span>
              </span>
            );
          })
        ) : (
          <span className="muted">no key runs yet — a steady tempo, threshold or long run with heart rate counts</span>
        )}
      </div>
      <div className="fit-predict">
        {f.predictions.map((p) => (
          <div key={p.name} title={p.target ? `Next: ${p.target}` : undefined}>
            <div className="label">{p.name}</div>
            <div className="num">{p.seconds ? duration(p.seconds) : "–"}</div>
            {p.targetSeconds && p.seconds && (
              <div className={"small " + (p.seconds <= p.targetSeconds ? "tone-accent" : "muted")}>target {duration(p.targetSeconds)}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export const fitnessModule: DashboardModule = {
  id: "fitness",
  title: "Fitness",
  defaultPos: { x: 0, y: 14, w: 7, h: 8 },
  minW: 4,
  minH: 6,
  Card: FitnessCard,
};
