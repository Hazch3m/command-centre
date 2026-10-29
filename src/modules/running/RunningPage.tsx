import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { mondayOf, upcomingRaces, weekFor, PLAN_FILE } from "./plan";
import {
  duration,
  judgeBenchmark,
  marathonBlocks,
  pace,
  raceHistory,
  resultOn,
  weeklyTotals,
  yearSummary,
  type BenchStatus,
} from "./stats";
import { useRunningData } from "./useRunning";
import { useFitness } from "./fitness";
import { FitnessTab } from "./FitnessTab";
import { WeekCalendar } from "./WeekCalendar";

type Tab = "week" | "fitness" | "plan" | "races" | "progress" | "paces";
const TABS: { id: Tab; label: string }[] = [
  { id: "week", label: "Week by week" },
  { id: "fitness", label: "Fitness & VO2 max" },
  { id: "plan", label: "Plan" },
  { id: "races", label: "Races & benchmarks" },
  { id: "progress", label: "Progression" },
  { id: "paces", label: "Paces & strength" },
];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_LABEL: Record<BenchStatus, string> = {
  "on-track": "On track",
  between: "Close",
  behind: "Behind",
  pending: "To come",
  manual: "Judge by feel",
};

function Tile({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="tile-value num">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

const fmtDate = (d: string) => {
  const x = parseKey(d);
  return `${x.getDate()} ${MON[x.getMonth()]}`;
};

export function RunningPage({ onClose }: { onClose: () => void }) {
  const today = useToday();
  const { plan, planError, runs = [], connected, sync } = useRunningData();
  const fitness = useFitness(plan);
  const [tab, setTab] = useState<Tab>("week");

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const data = useMemo(() => {
    if (!plan) return null;
    const planWeeks = plan.weeks.map((w) => {
      const total = weeklyTotals(runs, w.start, w.start)[0];
      return { ...w, actual: total.km, runs: total.runs, longest: total.longest };
    });
    const year = yearSummary(runs, today);
    const since = "2025-03-31";
    const weekly = weeklyTotals(runs, since, mondayOf(today)).map((w) => {
      const pw = weekFor(plan, w.week);
      return {
        label: parseKey(w.week).getDate() <= 7 ? MON[parseKey(w.week).getMonth()] : "",
        value: w.km,
        target: pw?.kmMin ?? null,
        targetMax: pw?.kmMax ?? null,
        highlight: w.week === mondayOf(today),
        title: `Week of ${fmtDate(w.week)} ${parseKey(w.week).getFullYear()}: ${w.km.toFixed(1)} km, ${w.runs} runs, longest ${w.longest.toFixed(1)} km${pw ? ` · plan ${pw.km} km` : ""}`,
      };
    });
    const races = raceHistory(runs, plan);
    return { planWeeks, year, weekly, races, blocks: marathonBlocks(runs, plan), upcoming: upcomingRaces(plan, today) };
  }, [plan, runs, today]);

  if (!plan || !data) return null;

  return createPortal(
    <div className="page-overlay" role="dialog" aria-label="Running">
      <header className="page-head">
        <div>
          <h1>{plan.title}</h1>
          <div className="muted small">
            From your training doc, exported {plan.exported} · {connected ? `Strava synced ${sync?.lastSync ? new Date(sync.lastSync).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}` : "Strava not connected"}
          </div>
        </div>
        <button className="btn" onClick={onClose}>
          Close (Esc)
        </button>
      </header>
      <ErrorNote error={planError} />
      <nav className="segmented page-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="page-body">
        {tab === "week" && <WeekCalendar plan={plan} runs={runs} />}

        {tab === "plan" && (
          <>
            {plan.phases
              .filter((p) => p.summary)
              .map((p) => (
                <p key={p.name} className="small">
                  <b>{p.name}</b> {p.start && p.end ? <span className="muted">({fmtDate(p.start)} – {fmtDate(p.end)})</span> : null}: {p.summary}
                </p>
              ))}
            <table className="table plan-table">
              <thead>
                <tr>
                  <th>Week</th>
                  <th>Dates</th>
                  <th className="num-col">Plan km</th>
                  <th className="num-col">Ran</th>
                  <th>Tuesday</th>
                  <th>Mid-week</th>
                  <th>Sunday</th>
                </tr>
              </thead>
              <tbody>
                {data.planWeeks.map((w) => {
                  const past = w.end < today;
                  const current = w.start <= today && today <= w.end;
                  const hit = w.kmMin ? w.actual / w.kmMin : null;
                  const cls = current ? "row-today" : past ? (hit == null ? "" : hit >= 0.9 ? "row-hit" : hit >= 0.7 ? "row-close" : "row-miss") : "";
                  return (
                    <tr key={w.week} className={cls} title={w.notes || undefined}>
                      <td>{w.week}</td>
                      <td className="nowrap">
                        {fmtDate(w.start)} – {fmtDate(w.end)}
                      </td>
                      <td className="num-col">{w.km}</td>
                      <td className="num-col">{past || current ? w.actual.toFixed(0) : ""}</td>
                      <td>{w.sessions.tue}</td>
                      <td>{w.sessions.thu ?? (w.sessions.wed ? `Wed: ${w.sessions.wed}` : "")}</td>
                      <td>{w.sessions.sun}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h3>After Edinburgh</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Dates</th>
                  <th>km/week</th>
                  <th>Key sessions</th>
                  <th>Race</th>
                </tr>
              </thead>
              <tbody>
                {plan.blocks.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td className="nowrap">{b.start && b.end ? `${fmtDate(b.start)} – ${fmtDate(b.end)}` : "–"}</td>
                    <td>{b.km}</td>
                    <td>{b.key}</td>
                    <td>{b.race}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              The plan lives in your Claude doc. To update it here, ask Claude to “re-export my training plan for Command Centre”, which writes {PLAN_FILE} in the app's data folder.
            </p>
          </>
        )}

        {tab === "races" && (
          <>
            <div className="tiles">
              {data.upcoming.slice(0, 4).map((r) => (
                <Tile key={r.name} label={r.name} value={`${r.days} days`} note={`${r.approx ? "≈ " : ""}${r.when} · target ${r.target}`} />
              ))}
            </div>
            <h3>Benchmarks</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Checkpoint</th>
                  <th>Date</th>
                  <th>On track</th>
                  <th>Behind</th>
                  <th>Result</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {plan.benchmarks.map((b) => {
                  const r = b.date && b.date <= today ? resultOn(runs, b.date) : null;
                  const status = judgeBenchmark(b, r ? r.elapsed_time : null);
                  return (
                    <tr key={b.name}>
                      <td>{b.name}</td>
                      <td className="nowrap">{b.when}</td>
                      <td>{b.onTrack}</td>
                      <td>{b.behind}</td>
                      <td className="num-col">{r ? duration(r.elapsed_time) : "–"}</td>
                      <td>
                        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted small">Results are read from Strava: the run marked as a race on that day, or the longest run that day.</p>
          </>
        )}

        {tab === "progress" && (
          <>
            <div className="tiles">
              <Tile label="Average week, last 52" value={`${data.year.avgKm.toFixed(0)} km`} note="Including breaks and travel" />
              <Tile label="Weeks under 15 km" value={data.year.weeksUnder15} note="Last 52 weeks; the plan's target is none" />
              <Tile label="Runs of 30 km+" value={data.year.runs30Plus} note="Last 52 weeks" />
              <Tile
                label="Best marathon"
                value={(() => {
                  const m = data.races.filter((r) => r.km > 42).sort((a, b) => a.time - b.time)[0];
                  return m ? duration(m.time) : "–";
                })()}
                note="Strava elapsed time"
              />
            </div>
            <h3>Kilometres per week since April 2025</h3>
            <p className="muted small">Bars: what you ran. Lines and bands: the plan's target for that week. Hover for details.</p>
            <BarChart bars={data.weekly} height={220} unit=" km" refLine={{ value: 50, label: "50 km: the plan's floor for a normal week" }} />

            <h3>Marathon blocks (16 weeks before race day)</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Block</th>
                  <th>Race day</th>
                  <th className="num-col">Avg km/week</th>
                  <th className="num-col">Weeks under 30 km</th>
                  <th className="num-col">Runs of 30 km+</th>
                  <th className="num-col">Longest</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {data.blocks.map((b) => (
                  <tr key={b.name}>
                    <td>{b.name}</td>
                    <td className="nowrap">{fmtDate(b.date)} {b.date.slice(0, 4)}</td>
                    <td className="num-col">{b.avgKm.toFixed(0)}</td>
                    <td className="num-col">{b.weeksUnder30}</td>
                    <td className="num-col">{b.runs30Plus}</td>
                    <td className="num-col">{b.longest.toFixed(1)} km</td>
                    <td>{b.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Every race, as a marathon equivalent</h3>
            <p className="muted small">Shorter races converted with Riegel's formula (exponent 1.06). Shorter bars are faster; the dashed line is 2:50. Green bars are actual marathons.</p>
            <BarChart
              bars={data.races.map((r) => ({
                label: r.date.slice(2, 4) + "/" + r.date.slice(5, 7),
                value: r.equiv / 60,
                highlight: r.km > 42,
                title: `${r.name} (${r.date}): ${duration(r.time)} → marathon ${duration(r.equiv)}`,
              }))}
              height={180}
              min={150}
              refLine={{ value: 170, label: "2:50:00" }}
            />
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Race</th>
                  <th className="num-col">Time</th>
                  <th className="num-col">Pace</th>
                  <th className="num-col">Marathon equivalent</th>
                </tr>
              </thead>
              <tbody>
                {[...data.races].reverse().map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{r.date}</td>
                    <td>{r.name}</td>
                    <td className="num-col">{duration(r.time)}</td>
                    <td className="num-col">{pace(r.km * 1000, r.time)}/km</td>
                    <td className="num-col">{duration(r.equiv)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!runs.length && <p className="muted">Connect Strava in Settings to fill these in.</p>}
          </>
        )}

        {tab === "fitness" && (fitness ? <FitnessTab f={fitness} /> : <p className="muted">Loading…</p>)}

        {tab === "paces" && (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Zone</th>
                  <th>Now (min/km)</th>
                  <th>Autumn 2027</th>
                  <th>Heart rate</th>
                  <th>Used for</th>
                </tr>
              </thead>
              <tbody>
                {plan.paces.map((p) => (
                  <tr key={p.zone}>
                    <td>{p.zone}</td>
                    <td className="num-col">{p.now}</td>
                    <td className="num-col">{p.autumn}</td>
                    <td>{p.hr}</td>
                    <td className="muted">{p.use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <h3>Weekly shape</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Phases 1–2</th>
                  <th>Phase 3</th>
                </tr>
              </thead>
              <tbody>
                {plan.structure.map((s) => (
                  <tr key={s.day}>
                    <td>{s.day}</td>
                    <td>{s.phases12}</td>
                    <td>{s.phase3}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="two-col">
              <div>
                <h3>Strength A (35–40 min)</h3>
                <ul className="bullets">
                  {plan.strength.A.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Strength B (20–25 min)</h3>
                <ul className="bullets">
                  {plan.strength.B.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
            <h3>Rules to stay healthy</h3>
            <ul className="bullets">
              {plan.rules.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

