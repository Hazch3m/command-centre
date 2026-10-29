import { addDays, useToday } from "../../core/time";
import { LineChart, type LineSeries } from "../../shell/charts";
import { CardHeader, Empty } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { fmtVo2, useFitness, type Fitness } from "./fitness";
import { duration } from "./stats";
import { useRunningData, useStravaSync } from "./useRunning";
import { FitnessTab } from "./FitnessTab";
import { type TrendStatus } from "./vo2";

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

function FitnessCard({ editing }: CardProps) {
  const today = useToday();
  useStravaSync();
  const { plan, connected } = useRunningData();
  const f = useFitness(plan);
  const to = editing ? undefined : "fitness";
  if (!f) return <CardHeader title="Fitness" to={to} />;
  if (!f.estimates.length)
    return (
      <>
        <CardHeader title="Fitness" to={to} />
        <Empty>
          {connected
            ? "Reading your runs' heart-rate splits from Strava. VO2 max appears once a few key runs are in (this backfills over the first hour or so)."
            : "Connect Strava in Settings to estimate VO2 max from your key runs."}
        </Empty>
      </>
    );
  const from = addDays(today, -16 * 7);
  const to2 = f.nextMilestone?.date ?? addDays(today, 26 * 7);
  const projNow = f.project(today);
  const diff = f.current != null && projNow != null ? f.current - projNow : null;
  return (
    <>
      <CardHeader
        title="Fitness"
        to={to}
        right={
          <span className={`status ${STATUS_CLASS[f.thisWeek.status]}`} title={`Week of ${f.thisWeek.week}`}>
            {STATUS_LABEL[f.thisWeek.status]}
          </span>
        }
      />
      <div className="fit-top">
        <div>
          <div className="num fit-big">{fmtVo2(f.current)}</div>
          <div className="muted small">VO2 max</div>
        </div>
        <div className="fit-facts small">
          <div>
            <span className="label">Plan</span> <span className="num">{fmtVo2(projNow)}</span>
            {diff != null && (
              <span className={diff >= -1 ? "tone-accent" : "tone-danger"}>
                {" "}
                ({diff >= 0 ? "+" : ""}
                {diff.toFixed(1)})
              </span>
            )}
          </div>
          {f.nextMilestone && (
            <div className="muted">
              Goal {f.nextMilestone.vo2.toFixed(1)} · {f.nextMilestone.label.split(" · ")[1] ?? f.nextMilestone.label}
            </div>
          )}
          {f.load.status && (
            <div className={f.load.status === "very-high" ? "tone-danger" : "muted"} title="Acute (7-day) ÷ chronic (28-day) training load">
              Load {f.load.ratio!.toFixed(2)} · {LOAD_LABEL[f.load.status]}
            </div>
          )}
        </div>
      </div>
      <div className="fit-chart">
        <LineChart series={vo2Series(f, from, to2)} from={from} to={to2} height={170} today={today} markers={f.config.projection.milestones.map((m) => ({ x: m.date, label: m.label.split(" · ")[0] }))} />
      </div>
      <div className="fit-predict-row" title={f.predictionBasis?.source === "race" ? `Race-ready times from ${f.predictionBasis.race!.name}` : "Race-ready times from current form"}>
        {f.predictions.map((p) => (
          <div key={p.name}>
            <span className="label">{p.name}</span>
            <span className={"num" + (p.targetSeconds && p.seconds && p.seconds <= p.targetSeconds ? " tone-accent" : "")}>{p.seconds ? duration(p.seconds) : "–"}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** The Fitness tab. */
function FitnessPage() {
  useStravaSync();
  const { plan } = useRunningData();
  const f = useFitness(plan);
  return (
    <div className="subpage">
      <header className="page-head">
        <div>
          <h1>Fitness &amp; VO2 max</h1>
          <div className="muted small">Estimated from your key runs' heart rate and pace, on your race-result scale unless you add Garmin readings below.</div>
        </div>
      </header>
      <div className="page-body">{f ? <FitnessTab f={f} /> : <p className="muted">Loading…</p>}</div>
    </div>
  );
}

export const fitnessModule: DashboardModule = {
  id: "fitness",
  title: "Fitness",
  defaultPos: { x: 7, y: 0, w: 5, h: 9 },
  minW: 4,
  minH: 6,
  Card: FitnessCard,
  page: { label: "Fitness", order: 2, Page: FitnessPage },
};
