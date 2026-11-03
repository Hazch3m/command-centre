import { useMemo, useState } from "react";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { LineChart } from "../../shell/charts";
import { MedalBadges } from "./Medals";
import { collectEfforts, fmtTime, medalsByRun, pbTable, type PbName } from "./pbs";
import { openRun } from "./RunView";
import { loadDetails, loadRuns } from "./strava";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]} ${parseKey(d).getFullYear()}`;
const paceOf = (s: number, m: number) => {
  const p = Math.round(s / (m / 1000));
  return `${Math.floor(p / 60)}:${String(p % 60).padStart(2, "0")}`;
};

/** Every run's efforts, the PB table and the medals, from all synced runs. */
export function usePbData() {
  const version = useDataVersion("running");
  const today = useToday();
  const { data } = useQuery(() => Promise.all([loadRuns("2000-01-01"), loadDetails("2000-01-01")]), [version]);
  return useMemo(() => {
    if (!data) return null;
    const efforts = collectEfforts(data[0], data[1]);
    return { efforts, medals: medalsByRun(efforts), table: pbTable(efforts, today), runs: data[0] };
  }, [data, today]);
}

/** Training → PBs: best times at each distance, how they've come down, and recent medals. */
export function PbsTab() {
  const pb = usePbData();
  const today = useToday();
  const [pick, setPick] = useState<PbName>("5K");
  if (!pb) return <p className="muted">Loading your runs…</p>;
  if (!pb.table.length) return <p className="muted">No best efforts yet: they come from Strava once runs have synced.</p>;
  const row = pb.table.find((r) => r.name === pick) ?? pb.table[0];
  const all = pb.efforts.filter((e) => e.name === row.name);
  const recentMedals = pb.runs
    .filter((r) => pb.medals.has(r.id))
    .slice(-12)
    .reverse();
  const first = all[0]?.date ?? today;
  // The PB as a staircase: flat until it's broken.
  const steps = row.progression.flatMap((e, i) => (i ? [{ x: addDays(e.date, -1), y: row.progression[i - 1].seconds }, { x: e.date, y: e.seconds }] : [{ x: e.date, y: e.seconds }]));
  steps.push({ x: today, y: row.progression[row.progression.length - 1].seconds });
  return (
    <div className="pbs">
      <div className="pb-grid">
        {pb.table.map((r) => {
          const best = r.top[0];
          const fresh = r.progression.length > 1 && best.date >= `${+today.slice(0, 4) - 1}${today.slice(4)}`;
          return (
            <button key={r.name} className={"pb-card" + (r.name === row.name ? " on" : "")} onClick={() => setPick(r.name)}>
              <span className="label">{r.label}</span>
              <b className="num">{fmtTime(best.seconds)}</b>
              <small className="muted num">
                {paceOf(best.seconds, r.m)}/km · {fmtDate(best.date)}
              </small>
              {fresh && <span className="pill small">new this year</span>}
            </button>
          );
        })}
      </div>

      <section className="pb-detail">
        <div className="pb-detail-head">
          <h3>{row.label}</h3>
          <span className="muted small">
            {all.length} effort{all.length === 1 ? "" : "s"} · PB broken {Math.max(0, row.progression.length - 1)} time{row.progression.length === 2 ? "" : "s"}
          </span>
        </div>
        <LineChart
          from={first}
          to={today}
          height={180}
          format={fmtTime}
          series={[
            { name: "Efforts", kind: "dots", className: "s-est", points: all.map((e) => ({ x: e.date, y: e.seconds, label: e.runName })) },
            { name: "PB", kind: "line", className: "s-pb", points: steps },
          ]}
        />
        <div className="pb-lists">
          <div>
            <h4>Fastest</h4>
            {row.top.map((e, i) => (
              <button key={e.runId} className="pb-line link" onClick={() => openRun(e.runId)}>
                <span className={`medal medal-${i + 1}`}>
                  <i>{i === 0 ? "PR" : i + 1}</i>
                </span>
                <b className="num">{fmtTime(e.seconds)}</b>
                <span className="muted num">{paceOf(e.seconds, row.m)}/km</span>
                <span className="pb-run">{e.runName}</span>
                <span className="muted small">{fmtDate(e.date)}</span>
              </button>
            ))}
            {row.yearBest && row.yearBest.runId !== row.top[0].runId && (
              <div className="small muted pb-year">
                Best in the last 12 months: <b>{fmtTime(row.yearBest.seconds)}</b> ({fmtDate(row.yearBest.date)})
              </div>
            )}
          </div>
          <div>
            <h4>How the PB came down</h4>
            {[...row.progression].reverse().map((e, i, arr) => (
              <button key={e.runId + e.date} className="pb-line link" onClick={() => openRun(e.runId)}>
                <span className="muted small">{fmtDate(e.date)}</span>
                <b className="num">{fmtTime(e.seconds)}</b>
                <span className="tone-accent num small">{arr[i + 1] ? `−${fmtTime(arr[i + 1].seconds - e.seconds)}` : "first"}</span>
                <span className="pb-run">{e.runName}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="pb-detail">
        <h3>Recent medals</h3>
        <p className="muted small">Like Strava: a run gets a medal for each distance where it was your fastest (PR), second or third fastest up to then.</p>
        {recentMedals.map((r) => (
          <button key={r.id} className="pb-line pb-medal-row link" onClick={() => openRun(r.id)}>
            <span className="muted small">{fmtDate(r.date)}</span>
            <span className="pb-run">{r.name}</span>
            <MedalBadges medals={pb.medals.get(r.id)} max={4} full />
          </button>
        ))}
      </section>
    </div>
  );
}
