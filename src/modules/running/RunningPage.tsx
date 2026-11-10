import { PlanCoach } from "./PlanCoach";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { addDays, parseKey, useToday } from "../../core/time";
import { BarChart, ScrollBars } from "../../shell/charts";
import { forecastWeek } from "./forecast";
import { useDataVersion } from "../../core/events";
import { useQuery } from "../../core/useQuery";
import { loadOverrides, type Run } from "./strava";
import type { Plan } from "./plan";
import { WeekProgress } from "../../phone/WeekProgress";
import { WeekAhead } from "../../phone/WeekAhead";
import { ErrorNote } from "../../shell/ui";
import { mondayOf, upcomingRaces, weekFor } from "./plan";
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
import { WeekCalendar } from "./WeekCalendar";
import { RecentBlock } from "./RecentBlock";
import { PaceOnPointTab } from "./PaceOnPoint";
import { RunsTab } from "./RunsTab";
import { AboutPlan, PlanSettings } from "./PlanSettings";
import { PlanBuilder } from "./BuildPlan";
import { PbsTab } from "./PbsTab";
import { TargetPrefs } from "./TargetPrefs";
import { RaceManager } from "./RaceManager";
import { ImportPlan } from "./ImportPlan";
import { PlanEditor } from "./PlanEditor";
import { PlanList } from "./PlanList";
import { PlanWeekView } from "./PlanWeekView";
import { WatchPage } from "../watch";
import { TrainingLoad } from "../../phone/TrainingLoad";
import { RunalyzeMore } from "../../phone/RunalyzeMore";
import { FitnessPredictor, GoalCarousel } from "../../phone/PlanGoals";

type Tab = "plan" | "trends" | "runs" | "pace" | "edit" | "progress" | "watch";
// Fewer, fuller tabs: trends with training load, races with PBs.
const TABS: { id: Tab; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "runs", label: "Runs" },
  { id: "trends", label: "Trends & load" },
  { id: "pace", label: "Pace on point" },
  { id: "progress", label: "Races & PBs" },
  { id: "watch", label: "Watch" },
  { id: "edit", label: "Edit plan" },
];
const PLAN_VIEWS = [
  { id: "week", label: "Week" },
  { id: "list", label: "All weeks" },
  { id: "six", label: "6 weeks" },
] as const;
const EDIT_VIEWS = [
  { id: "build", label: "Build a plan" },
  { id: "races", label: "Races" },
  { id: "import", label: "Import CSV" },
  { id: "adjust", label: "Adjust" },
  { id: "about", label: "About this plan" },
  { id: "weeks", label: "Edit week by week" },
] as const;
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

/** How the week's going: progress, streaks. */
function WeekProgressCard({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const today = useToday();
  const version = useDataVersion("running");
  const { data: overrides } = useQuery(loadOverrides, [version]);
  const fw = useMemo(() => forecastWeek(plan, mondayOf(today), runs, overrides), [plan, today, runs, overrides]);
  return (
    <div className="pl-embed">
      <WeekProgress plan={plan} fw={fw} runs={runs} today={today} overrides={overrides} />
    </div>
  );
}

/** The Training tab: the plan week by week, the whole plan, races, progression, paces. */
export function RunningPage() {
  const today = useToday();
  const { plan, planError, runs = [], connected, sync } = useRunningData();
  const [tab, setTab] = useState<Tab>("plan");
  // Links elsewhere ("Pace on point ›" on a goal card) switch the tab.
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<string>).detail;
      if (d === "pace" || d === "progress" || d === "runs" || d === "plan") setTab(d);
    };
    window.addEventListener("cc:plan-view", on);
    return () => window.removeEventListener("cc:plan-view", on);
  }, []);
  const [view, setView] = useState<(typeof PLAN_VIEWS)[number]["id"]>("week");
  const [editView, setEditView] = useState<(typeof EDIT_VIEWS)[number]["id"]>("build");

  const data = useMemo(() => {
    if (!plan) return null;
    const year = yearSummary(runs, today);
    // From your first run (at most two years back), through the plan's weeks ahead.
    const first = runs.reduce((a, r) => (r.date < a ? r.date : a), today);
    const since = mondayOf(first < addDays(today, -730) ? addDays(today, -730) : first);
    const past = weeklyTotals(runs, since, mondayOf(today)).map((w) => {
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
    const ahead = plan.weeks
      .filter((w) => w.start > mondayOf(today))
      .slice(0, 52)
      .map((pw) => {
        const km = forecastWeek(plan, pw.start).plannedKm ?? (pw.kmMin != null ? (pw.kmMin + (pw.kmMax ?? pw.kmMin)) / 2 : 0);
        return {
          label: parseKey(pw.start).getDate() <= 7 ? MON[parseKey(pw.start).getMonth()] : "",
          value: km,
          target: pw.kmMin,
          targetMax: pw.kmMax,
          planned: true,
          title: `Week of ${fmtDate(pw.start)} ${parseKey(pw.start).getFullYear()}: planned ${Math.round(km)} km${pw.phase ? ` · ${pw.phase}` : ""}`,
        };
      });
    const weekly = [...past, ...ahead];
    const nowIndex = past.length - 1;
    const sinceLabel = `${MON[parseKey(since).getMonth()]} ${parseKey(since).getFullYear()}`;
    const races = raceHistory(runs, plan);
    return { year, weekly, nowIndex, sinceLabel, races, blocks: marathonBlocks(runs, plan), upcoming: upcomingRaces(plan, today) };
  }, [plan, runs, today]);

  if (!plan || !data) return null;

  return (
    <div className="subpage">
      <header className="page-head train-head">
        <div className="train-title">
          <h1>{plan.title}</h1>
          <div className="muted small">
            {plan.editedInApp ? "Edited in the app" : `From your training doc, exported ${plan.exported}`} · {connected ? `${sync?.source === "garmin" ? "Garmin" : sync?.source === "both" ? "Garmin and Strava" : "Strava"} synced ${sync?.lastSync ? new Date(sync.lastSync).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}` : "Runs: connect Garmin in Settings"}
          </div>
        </div>
        <nav className="segmented page-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <ErrorNote error={planError} />

      <div className="page-body" key={tab}>
        {tab === "pace" && <PaceOnPointTab plan={plan} runs={runs} />}
        {tab === "trends" && <RecentBlock runs={runs} plan={plan} />}
        {tab === "trends" && <h3>Training load</h3>}
        {tab === "runs" && <RunsTab runs={runs} plan={plan} />}

        {tab === "watch" && <WatchPage />}
        {tab === "trends" && (
          <div className="pl-embed pl-cols">
            <div>
              <TrainingLoad />
            </div>
            <div>
              <FitnessPredictor plan={plan} />
              <RunalyzeMore />
            </div>
          </div>
        )}
        {tab === "edit" && (
          <>
            <div className="plan-view-switch">
              <span className="segmented small-seg">
                {EDIT_VIEWS.map((v) => (
                  <button key={v.id} className={editView === v.id ? "on" : ""} onClick={() => setEditView(v.id)}>
                    {v.label}
                  </button>
                ))}
              </span>
              {plan.adjust && <span className="pill small">Your settings are on</span>}
            </div>
            {editView === "build" && <PlanBuilder plan={plan} />}
            {editView === "races" && <RaceManager plan={plan} />}
            {editView === "import" && <ImportPlan plan={plan} />}
            {editView === "adjust" && <PlanSettings plan={plan} />}
            {editView === "about" && <AboutPlan plan={plan} />}
            {editView === "weeks" && <PlanEditor plan={plan} />}
          </>
        )}

        {tab === "plan" && (
          <>
            <div className="plan-view-switch plan-toolbar">
              <span className="segmented small-seg">
                {PLAN_VIEWS.map((v) => (
                  <button key={v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
                    {v.label}
                  </button>
                ))}
              </span>
              <details className="fold targets-fold">
                <summary>
                  Targets <span className="muted small">{plan.prefs?.mode === "hr" ? "heart rate" : "pace"} · easy runs {plan.prefs?.easyTarget === "feel" ? "by feel" : plan.prefs?.easyTarget === "wide" ? "wider range" : "plan's range"}{plan.prefs?.easyChecks ? "" : ", not judged"}</span>
                </summary>
                <TargetPrefs />
              </details>
            </div>
            {/* The week (or weeks) first and widest; how the plan's going alongside. */}
            {view === "week" ? (
              /* The week across the top; under it how it's going, what's coming, and the goal. */
              <div className="plan-home">
                <div className="plan-home-week">
                  <PlanWeekView plan={plan} runs={runs} />
                </div>
                <div className="plan-home-col">
                  <WeekProgressCard plan={plan} runs={runs} />
                  <PlanCoach plan={plan} />
                </div>
                <div className="plan-home-col pl-embed">
                  <WeekAhead plan={plan} onDay={(d) => window.dispatchEvent(new CustomEvent("cc:plan-day", { detail: d }))} />
                </div>
                <div className="plan-home-goal pl-embed">
                  <GoalCarousel plan={plan} split />
                </div>
              </div>
            ) : (
              <div className="plan-focus">
                <div className="plan-focus-main">
                  {view === "list" && <PlanList plan={plan} runs={runs} />}
                  {view === "six" && <WeekCalendar plan={plan} runs={runs} count={6} />}
                </div>
                <aside className="plan-focus-side">
                  <PlanCoach plan={plan} />
                  <div className="pl-embed">
                    <GoalCarousel plan={plan} />
                  </div>
                </aside>
              </div>
            )}
          </>
        )}
        {tab === "progress" && <PbsTab />}
        {tab === "progress" && <h3>Races</h3>}
        {tab === "progress" && (
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
            <p className="muted small">Results are read from your runs: the run marked as a race on that day, or the longest run that day.</p>
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
                note="elapsed time"
              />
            </div>
            <h3>Kilometres per week since {data.sinceLabel}</h3>
            <p className="muted small">Bars: what you ran; faint bars: the weeks your plan has ahead (scroll right). Bands: the plan's target for that week. Hover for details.</p>
            <ScrollBars bars={data.weekly} height={220} unit=" km" perBar={16} focus={data.nowIndex} showValues={false} />

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
            <p className="muted small">Shorter races converted with Riegel's formula (exponent 1.06). Shorter bars are faster; the dashed line is your best. Green bars are actual marathons.</p>
            <BarChart
              bars={data.races.map((r) => ({
                label: r.date.slice(2, 4) + "/" + r.date.slice(5, 7),
                value: r.equiv / 60,
                highlight: r.km > 42,
                title: `${r.name} (${r.date}): ${duration(r.time)} → marathon ${duration(r.equiv)}`,
              }))}
              height={180}
              min={data.races.length ? Math.floor((Math.min(...data.races.map((r) => r.equiv)) / 60) * 0.9) : 0}
              refLine={data.races.length ? { value: Math.min(...data.races.map((r) => r.equiv)) / 60, label: `Best: ${duration(Math.min(...data.races.map((r) => r.equiv)))}` } : null}
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
            {!runs.length && <p className="muted">Connect Garmin in Settings to fill these in.</p>}
          </>
        )}


        {tab === "plan" && (
          <details className="fold">
            <summary>
              <h3>Training paces, weekly shape and strength</h3>
              <span className="muted small">the reference tables from the plan</span>
            </summary>
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
          </details>
        )}
      </div>
    </div>
  );
}

