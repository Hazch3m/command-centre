import { useMemo } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { latest as latestHealth, loadHealth } from "../modules/health/data";
import { useFitness } from "../modules/running/fitness";
import { forecastWeek, type ForecastDay } from "../modules/running/forecast";
import { mondayOf, priorityOf, upcomingRaces } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { pace } from "../modules/running/stats";
import { loadDetails, loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { predictionChange } from "../modules/running/goalTrend";
import { EffortProfile, segmentsOf, zoneOf } from "../phone/EffortProfile";
import { sessionTitle } from "../phone/Today";
import { BuildingCard, RaceEquivalence } from "./HomeCharts";
import { useNav } from "./nav";
import { CoachCard } from "../modules/running/Coach";
import "../styles/home.css";

/**
 * The web and PC home: running first, dense and readable rather than big tiles. Numbers across the
 * top, the week and what's next, volume and load, what's missing per distance, recent runs and
 * race times, and a thin line of health.
 */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const isRun = (d: ForecastDay) => d.kind !== "rest" && (d.km ?? 0) > 0 && !/^rest\b/i.test(d.text);

/** Opens a day in Training → Plan (its day editor). */
function openDay(go: (t: string) => void, date: string) {
  try {
    sessionStorage.setItem("cc-plan-day", date);
  } catch {
    /* private mode */
  }
  go("running");
  window.setTimeout(() => window.dispatchEvent(new CustomEvent("cc:plan-day", { detail: date })), 350);
}

/** "Faster after Tuesday's run: 5K −9 s, 10K −21 s" – the last run that moved Garmin's predictions (last 7 days). */
function PredictionNews({ runs, today }: { runs: { date: string; id: string; name: string }[]; today: string }) {
  const hv = useDataVersion("health");
  const dates = useMemo(() => [...new Set(runs.filter((r) => r.date >= addDays(today, -7)).map((r) => r.date))].sort().reverse(), [runs, today]);
  const { data } = useQuery(async () => {
    for (const d of dates) {
      const ch = await predictionChange(d);
      if (ch.length) return { date: d, ch };
    }
    return null;
  }, [dates.join(","), hv]);
  if (!data) return null;
  const better = data.ch.filter((x) => x.after < x.before);
  const run = runs.find((r) => r.date === data.date);
  const day = data.date === today ? "today's run" : `${DOW[(parseKey(data.date).getDay() + 6) % 7]}'s run`;
  const sec = (v: number) => {
    const a = Math.abs(Math.round(v));
    return a >= 60 ? `${Math.floor(a / 60)}:${String(a % 60).padStart(2, "0")}` : `${a} s`;
  };
  return (
    <button type="button" className={"home-pred-news " + (better.length >= data.ch.length / 2 ? "up" : "down")} onClick={() => run && openRun(run.id)}>
      <b>{better.length === data.ch.length ? "▲ Faster" : better.length ? "Moved" : "▼ Slower"}</b> after {day}:{" "}
      {data.ch.map((x) => `${x.name} ${x.after < x.before ? "−" : "+"}${sec(x.after - x.before)}`).join(" · ")}
    </button>
  );
}

export function Home() {
  const today = useToday();
  const { go } = useNav();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan ?? undefined);
  const rv = useDataVersion("running");
  const hv = useDataVersion("health");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const details = useQuery(() => loadDetails(addDays(today, -120)), [rv, today]).data;
  const health = useQuery(() => loadHealth(14), [hv]).data ?? [];

  const monday = mondayOf(today);
  const weeks = useMemo(() => (plan ? [forecastWeek(plan, monday, runs, overrides), forecastWeek(plan, addDays(monday, 7), runs, overrides)] : null), [plan, monday, runs, overrides]);

  if (!plan || !weeks) return <div className="home-wait">Loading your training…</div>;
  const [fw, next] = weeks;
  const races = upcomingRaces(plan, today);
  const goal = races.find((r) => priorityOf(r) === "A") ?? races[0] ?? null;
  const pk = fw.plannedKm ?? 0;
  const pct = pk ? Math.min(1, fw.actualKm / pk) : 0;
  const upcoming = [...fw.days, ...next.days].filter((d) => d.date >= today && isRun(d) && !(d.date === today && d.runs.length));
  const keys = upcoming.filter((d) => d.kind === "key" || d.kind === "long" || d.race).slice(0, 4);
  const recent = [...runs].sort((a, b) => b.start_local.localeCompare(a.start_local)).slice(0, 5);
  const h = latestHealth(health);
  const left = fw.days.filter((d) => d.date >= today && isRun(d) && !d.runs.length).reduce((a, d) => a + (d.km ?? 0), 0);

  return (
    <div className="hv">
      {/* One line: where you are this week, the race you're building to, how you've recovered. */}
      <header className="hv-head">
        <div className="hv-wk">
          <span className="hv-eyebrow">
            {fw.week ? `Week ${fw.week.week}` : "This week"}
            {fw.week?.phase ? ` · ${fw.week.phase.replace(/\s*\(.*\)\s*$/, "")}` : ""} · {fmt(monday)} – {fmt(addDays(monday, 6))}
          </span>
          <span className="hv-km">
            <b className="num">{fw.actualKm.toFixed(fw.actualKm < 10 ? 1 : 0)}</b> of {Math.round(pk)} km
            {left > 0 && <small> · {Math.round(left)} km to go</small>}
          </span>
          <span className="hv-bar" aria-hidden="true">
            <i style={{ width: `${pct * 100}%` }} />
          </span>
        </div>
        {goal && (
          <button type="button" className="hv-race" onClick={() => go("running")}>
            <span className="hv-eyebrow">Building to</span>
            <b>{goal.name}</b>
            <small>
              <span className="num">{goal.days}</span> days{goal.target ? ` · goal ${goal.target}` : ""}
            </small>
          </button>
        )}
        <div className="hv-health" role="group" aria-label="Recovery">
          {h.readiness != null && (
            <span>
              <small>Readiness</small>
              <b className="num">{h.readiness}</b>
            </span>
          )}
          {h.hrv != null && (
            <span>
              <small>HRV</small>
              <b className="num">{Math.round(h.hrv)}</b>
            </span>
          )}
          {h.rhr != null && (
            <span>
              <small>RHR</small>
              <b className="num">{Math.round(h.rhr)}</b>
            </span>
          )}
          {h.sleep_secs != null && (
            <span>
              <small>Sleep</small>
              <b className="num">
                {Math.floor(h.sleep_secs / 3600)}:{String(Math.round((h.sleep_secs % 3600) / 60)).padStart(2, "0")}
              </b>
            </span>
          )}
        </div>
      </header>

      <PredictionNews runs={runs} today={today} />

      {/* This week, day by day, with each session's shape. */}
      <section className="hv-week home-week" aria-label="This week">
        {fw.days.map((d, i) => {
          const run = isRun(d) || !!d.race;
          const z = d.race ? "race" : run ? zoneOf(d.text, d.kind) : "rest";
          const work = run && !d.race ? segmentsOf(d.text, plan).find((x) => x.kind === "work") : undefined;
          return (
            <button type="button" key={d.date} className={`hv-day z-${z}` + (d.date === today ? " today" : "") + (d.runs.length ? " done" : d.date < today && run ? " missed" : "")} onClick={() => openDay(go, d.date)}>
              <span className="hv-day-top">
                <b>{d.date === today ? "Today" : DOW[i]}</b> <span>{parseKey(d.date).getDate()}</span>
                {d.runs.length > 0 && <span className="hv-tick">✓ {d.actualKm.toFixed(1)}</span>}
              </span>
              {run ? (
                <>
                  <span className="hv-day-km num">
                    {d.km}
                    <small> km</small>
                  </span>
                  <span className="hv-day-title">{d.race ? d.race.name : sessionTitle(d.text, d.kind)}</span>
                  {work && <span className="hv-day-work">{work.label}</span>}
                  {!d.race && <EffortProfile text={d.text} kind={d.kind} plan={plan} height={30} />}
                </>
              ) : (
                <span className="hv-day-rest">Rest</span>
              )}
            </button>
          );
        })}
      </section>

      <CoachCard plan={plan} runs={runs} wide />

      <div className="hv-body">
        <div className="hv-col hv-main">
          {f && details && <BuildingCard f={f} runs={runs} details={details} today={today} />}
          <section className="hv-sec hv-runs">
            <header>
              <h2>Recent runs</h2>
              <button type="button" className="hv-link" onClick={() => go("running")}>
                All runs ›
              </button>
            </header>
            <table className="hv-table">
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="hv-click" onClick={() => openRun(r.id)}>
                    <td className="nowrap muted">{r.date === today ? "Today" : fmt(r.date)}</td>
                    <td className="hv-name">{r.name}</td>
                    <td className="r num">{(r.distance / 1000).toFixed(1)} km</td>
                    <td className="r num">{pace(r.distance, r.moving_time)}/km</td>
                    <td className="r num muted">{r.avg_hr ? `${Math.round(r.avg_hr)} bpm` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <div className="hv-col hv-side">
          <section className="hv-sec hv-next">
            <header>
              <h2>Coming up</h2>
              <button type="button" className="hv-link" onClick={() => go("running")}>
                Plan ›
              </button>
            </header>
            <ul className="hv-list">
              {keys.length === 0 && <li className="muted">No key sessions in the next two weeks.</li>}
              {keys.map((d) => (
                <li key={d.date}>
                  <button type="button" onClick={() => openDay(go, d.date)} className={`z-${d.race ? "race" : zoneOf(d.text, d.kind)}`}>
                    <span className="hv-when">
                      {d.date === today ? "Today" : DOW[(parseKey(d.date).getDay() + 6) % 7]} <small>{parseKey(d.date).getDate()}</small>
                    </span>
                    <span className="hv-what" title={d.text}>
                      <b>{d.race ? d.race.name : sessionTitle(d.text, d.kind)}</b>
                      <small>{d.text}</small>
                    </span>
                    <span className="num hv-list-km">{d.km} km</span>
                  </button>
                </li>
              ))}
            </ul>
            {races.length > 0 && (
              <ul className="hv-races">
                {races.slice(0, 3).map((r) => (
                  <li key={r.name + r.date}>
                    <span className={`hv-pri pri-${priorityOf(r)}`}>{priorityOf(r)}</span>
                    <span className="hv-race-name">{r.name}</span>
                    <span className="muted">{r.target ?? ""}</span>
                    <span className="num">{r.days} d</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {f && <RaceEquivalence f={f} runs={runs} plan={plan} today={today} />}
        </div>
      </div>
    </div>
  );
}
