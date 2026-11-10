import { useMemo } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { latest as latestHealth, loadHealth } from "../modules/health/data";
import { useFitness } from "../modules/running/fitness";
import { forecastWeek, type ForecastDay } from "../modules/running/forecast";
import { mondayOf, priorityOf, upcomingRaces } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { duration, pace } from "../modules/running/stats";
import { loadDetails, loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { predictionChange } from "../modules/running/goalTrend";
import { EffortProfile, segmentsOf, zoneOf } from "../phone/EffortProfile";
import { sessionTitle } from "../phone/Today";
import { BuildingCard, RaceEquivalence } from "./HomeCharts";
import { useNav } from "./nav";

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
  const nextRace = races[0] ?? null;
  const pk = fw.plannedKm ?? 0;
  const upcoming = [...fw.days, ...next.days].filter((d) => d.date >= today && isRun(d) && !(d.date === today && d.runs.length));
  const keys = upcoming.filter((d) => d.kind === "key" || d.kind === "long" || d.race).slice(0, 3);
  const recent = [...runs].sort((a, b) => b.start_local.localeCompare(a.start_local)).slice(0, 7);
  const h = latestHealth(health);

  return (
    <div className="home">

      <div className="home-grid">
        {/* This week, day by day, with each session's shape. */}
        <section className="home-card home-week">
          <header>
            <h3>This week</h3>
            <span className="muted small">
              {fmt(monday)} – {fmt(addDays(monday, 6))} · <b>{fw.actualKm.toFixed(fw.actualKm < 10 ? 1 : 0)}</b> of {Math.round(pk)} km
              {goal ? ` · ${goal.name} in ${goal.days} days` : ""}
              {nextRace && nextRace !== goal ? ` · next race: ${nextRace.name} in ${nextRace.days} days` : ""}
            </span>
            <button type="button" className="home-link" onClick={() => go("running")}>
              Plan ›
            </button>
          </header>
          <div className="hw-days">
            {fw.days.map((d, i) => {
              const run = isRun(d) || d.race;
              const z = d.race ? "race" : run ? zoneOf(d.text, d.kind) : "rest";
              const segs = run && !d.race ? segmentsOf(d.text, plan) : [];
              return (
                <button type="button" key={d.date} className={`hw-day z-${z}` + (d.date === today ? " today" : "") + (d.runs.length ? " done" : d.date < today && run ? " missed" : "")} onClick={() => openDay(go, d.date)}>
                  <span className="hw-top">
                    <b>{DOW[i]}</b> <span className="muted">{parseKey(d.date).getDate()}</span>
                    {d.runs.length > 0 && <span className="hw-tick">✓ {d.actualKm.toFixed(1)}</span>}
                  </span>
                  {run ? (
                    <>
                      <span className="hw-km num">
                        {d.km}
                        <small> km</small>
                      </span>
                      <span className="hw-title">{d.race ? d.race.name : sessionTitle(d.text, d.kind)}</span>
                      {!d.race && <EffortProfile text={d.text} kind={d.kind} plan={plan} height={48} />}
                      {segs.length > 0 && (
                        <span className="hw-segs">
                          {segs.map((s, j) => (
                            <span key={j} className={`seg-${s.kind}`}>
                              {s.label.replace(/^Warm-up$/, "WU").replace(/^Cool-down$/, "CD")}
                              {s.km && !/\bkm\b/.test(s.label) ? ` ${s.km >= 9.95 ? Math.round(s.km) : Math.round(s.km * 10) / 10} km` : ""}
                            </span>
                          ))}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="hw-rest">Rest</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {/* What's coming: the key sessions and races of the next fortnight. */}
        <section className="home-card home-next">
          <header>
            <h3>Coming up</h3>
            <span className="muted small">key sessions, next two weeks</span>
          </header>
          <ul className="hn-list">
            {keys.length === 0 && <li className="muted small">No key sessions in the next two weeks.</li>}
            {keys.map((d) => (
              <li key={d.date}>
                <button type="button" onClick={() => openDay(go, d.date)} className={`z-${d.race ? "race" : zoneOf(d.text, d.kind)}`}>
                  <span className="hn-when">
                    {DOW[(parseKey(d.date).getDay() + 6) % 7]} <small>{fmt(d.date)}</small>
                  </span>
                  <span className="hn-what">
                    <b>{d.race ? d.race.name : sessionTitle(d.text, d.kind)}</b>
                    <small>{d.text}</small>
                  </span>
                  <span className="hn-km num">{d.km} km</span>
                </button>
              </li>
            ))}
          </ul>
          {races.length > 0 && (
            <>
              <h4>Races</h4>
              <ul className="hn-races">
                {races.slice(0, 4).map((r) => (
                  <li key={r.name + r.date}>
                    <span className={`hn-pri pri-${priorityOf(r)}`}>{priorityOf(r)}</span>
                    <span className="hn-race">{r.name}</span>
                    <span className="muted small">{r.target ?? ""}</span>
                    <span className="num">{r.days} d</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* Are you building: km by intensity with VO2 max over it, and what it adds up to. */}
        {f && details && <BuildingCard f={f} runs={runs} details={details} today={today} />}
        {f && <RaceEquivalence f={f} runs={runs} plan={plan} today={today} news={<PredictionNews runs={runs} today={today} />} />}

        <section className="home-card home-runs">
          <header>
            <h3>Recent runs</h3>
            <span className="muted small">
              {h.rhr ? `RHR ${Math.round(h.rhr)}` : ""}
              {h.hrv ? ` · HRV ${Math.round(h.hrv)}` : ""}
            </span>
            <button type="button" className="home-link" onClick={() => go("running")}>
              All runs ›
            </button>
          </header>
          <table className="home-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Run</th>
                <th className="r">km</th>
                <th className="r">Pace</th>
                <th className="r">HR</th>

              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="home-click" onClick={() => openRun(r.id)}>
                  <td className="nowrap">{r.date === today ? "Today" : fmt(r.date)}</td>
                  <td className="home-name">{r.name}</td>
                  <td className="r num">{(r.distance / 1000).toFixed(1)}</td>
                  <td className="r num">{pace(r.distance, r.moving_time)}</td>
                  <td className="r num">{r.avg_hr ? Math.round(r.avg_hr) : "–"}</td>

                </tr>
              ))}
            </tbody>
          </table>
        </section>

      </div>

    </div>
  );
}
