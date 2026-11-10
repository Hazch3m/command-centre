import { useMemo } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { latest as latestHealth, loadHealth } from "../modules/health/data";
import { useFitness } from "../modules/running/fitness";
import { forecastWeek, type ForecastDay } from "../modules/running/forecast";
import { mondayOf, priorityOf, upcomingRaces, weekFor, type PlanRace } from "../modules/running/plan";
import { openRun, openWeek } from "../modules/running/RunView";
import { duration, pace, weeklyTotals } from "../modules/running/stats";
import { loadDetails, loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { EffortProfile, segmentsOf, zoneOf } from "../phone/EffortProfile";
import { sessionTitle } from "../phone/Today";
import { BarChart } from "./charts";
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
const raceKm = (r: PlanRace) => r.km ?? (/half/i.test(r.name) ? 21.1 : /marathon/i.test(r.name) ? 42.2 : /10\s?k/i.test(r.name) ? 10 : /5\s?k/i.test(r.name) ? 5 : null);
const LOAD_TEXT: Record<string, string> = { low: "Fresh: room to build", optimal: "In the sweet spot", high: "Building fast", "very-high": "Too steep: ease off" };

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
  const bars = useMemo(() => {
    if (!plan) return { bars: [], focus: 0, weeks: [] as string[] };
    const past = Array.from({ length: 12 }, (_, i) => addDays(monday, (i - 11) * 7));
    const tot = new Map(weeklyTotals(runs, past[0], monday).map((w) => [w.week, w]));
    const ahead = plan.weeks.filter((w) => w.start > monday).slice(0, 8).map((w) => w.start);
    const label = (w: string, i: number) => (parseKey(w).getDate() <= 7 || i === 0 ? MON[parseKey(w).getMonth()] : "");
    return {
      weeks: past,
      focus: past.length - 1,
      bars: [
        ...past.map((w, i) => {
          const pw = weekFor(plan, w);
          const t = tot.get(w);
          return { label: label(w, i), value: t?.km ?? 0, target: pw?.kmMin ?? null, targetMax: pw?.kmMax ?? null, highlight: w === monday, title: `Week of ${fmt(w)}: ${(t?.km ?? 0).toFixed(1)} km, ${t?.runs ?? 0} runs` };
        }),
        ...ahead.map((w, i) => {
          const pw = weekFor(plan, w);
          const km = forecastWeek(plan, w, [], overrides).plannedKm ?? 0;
          return { label: label(w, i + 1), value: km, target: pw?.kmMin ?? null, targetMax: pw?.kmMax ?? null, planned: true, title: `Week of ${fmt(w)}: planned ${Math.round(km)} km${pw?.phase ? ` · ${pw.phase}` : ""}` };
        }),
      ],
    };
  }, [plan, runs, monday, overrides]);

  if (!plan || !weeks) return <div className="home-wait">Loading your training…</div>;
  const [fw, next] = weeks;
  const races = upcomingRaces(plan, today);
  const goal = races.find((r) => priorityOf(r) === "A") ?? races[0] ?? null;
  const nextRace = races[0] ?? null;
  const pk = fw.plannedKm ?? 0;
  const pct = pk ? Math.min(1, fw.actualKm / pk) : 0;
  const upcoming = [...fw.days, ...next.days].filter((d) => d.date >= today && isRun(d) && !(d.date === today && d.runs.length));
  const nextRun = upcoming[0] ?? null;
  const keys = upcoming.filter((d) => d.kind === "key" || d.kind === "long" || d.race).slice(0, 4);
  const vo2 = f?.current != null ? f.current + f.shift : null;
  const vo2ch = f?.slope != null ? f.slope * 4 : null;
  const est = new Map((f?.estimates ?? []).map((e) => [e.id, e.vo2 + (f?.shift ?? 0)]));
  const recent = [...runs].sort((a, b) => b.start_local.localeCompare(a.start_local)).slice(0, 8);
  const h = latestHealth(health);
  const gk = goal ? raceKm(goal) : null;
  const goalPred = gk != null && f ? f.predictions.find((p) => Math.abs(p.distance / 1000 - gk) < 0.6) : null;

  return (
    <div className="home">
      {/* The numbers that matter, at a glance. */}
      <section className="home-kpis">
        <button type="button" className="kpi" onClick={() => go("running")}>
          <span className="kpi-l">This week</span>
          <span className="kpi-v num">
            {fw.actualKm.toFixed(fw.actualKm < 10 ? 1 : 0)}
            <small> / {Math.round(pk)} km</small>
          </span>
          <span className="kpi-bar">
            <i style={{ width: `${pct * 100}%` }} />
          </span>
          <span className="kpi-s">
            {fw.days.filter((d) => d.runs.length && d.date <= today).length} of {fw.days.filter(isRun).length} runs{fw.week ? ` · week ${fw.week.week}, ${fw.week.phase.replace(/^Phase \d+:\s*/i, "")}` : ""}
          </span>
        </button>
        <button type="button" className="kpi" onClick={() => nextRun && openDay(go, nextRun.date)} disabled={!nextRun}>
          <span className="kpi-l">Next run{nextRun ? ` · ${nextRun.date === today ? "today" : nextRun.date === addDays(today, 1) ? "tomorrow" : DOW[(parseKey(nextRun.date).getDay() + 6) % 7]}` : ""}</span>
          <span className="kpi-v num">
            {nextRun ? nextRun.km : "–"}
            <small> km</small>
          </span>
          <span className="kpi-s">{nextRun ? sessionTitle(nextRun.text, nextRun.kind) : "Nothing planned"}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go("fitness")}>
          <span className="kpi-l">VO2 max</span>
          <span className="kpi-v num">{vo2 != null ? vo2.toFixed(1) : "–"}</span>
          <span className={"kpi-s " + (vo2ch == null ? "" : vo2ch >= 0.2 ? "up" : vo2ch <= -0.2 ? "down" : "")}>{vo2ch == null ? "Needs runs with heart rate" : `${vo2ch >= 0 ? "+" : "−"}${Math.abs(vo2ch).toFixed(1)} over 4 weeks`}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go("analysis")}>
          <span className="kpi-l">Training load</span>
          <span className="kpi-v num">{f?.load.ratio != null ? f.load.ratio.toFixed(2) : "–"}</span>
          <span className={`kpi-s load-${f?.load.status ?? "none"}`}>{f?.load.status ? LOAD_TEXT[f.load.status] : "Acute : chronic"}</span>
        </button>
        <button type="button" className="kpi" onClick={() => go("running")} disabled={!goal}>
          <span className="kpi-l">{goal ? goal.name : "Goal race"}</span>
          <span className="kpi-v num">
            {goal ? goal.days : "–"}
            <small> days</small>
          </span>
          <span className="kpi-s">
            {goal ? `${goal.target ? `goal ${goal.target}` : fmt(goal.date!)}${goalPred?.seconds ? ` · now ${duration(goalPred.seconds)}` : ""}` : "Add one in Training → Edit plan"}
          </span>
        </button>
        <button type="button" className="kpi" onClick={() => go("analysis")}>
          <span className="kpi-l">Marathon shape</span>
          <span className="kpi-v num">{f?.shape ? `${Math.round(f.shape.total * 100)}` : "–"}<small> %</small></span>
          <span className="kpi-bar">
            <i style={{ width: `${Math.min(1, f?.shape?.total ?? 0) * 100}%` }} />
          </span>
          <span className="kpi-s">volume and long runs for 42 km</span>
        </button>
      </section>

      <div className="home-grid">
        {/* This week, day by day, with each session's shape. */}
        <section className="home-card home-week">
          <header>
            <h3>This week</h3>
            <span className="muted small">
              {fmt(monday)} – {fmt(addDays(monday, 6))}
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
                      {!d.race && <EffortProfile text={d.text} kind={d.kind} plan={plan} height={20} />}
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
            <h3>Key sessions</h3>
            <span className="muted small">next two weeks</span>
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
        </section>

        {/* Are you building: km by intensity with VO2 max over it, and what it adds up to. */}
        {f && details && <BuildingCard f={f} runs={runs} details={details} today={today} />}
        {f && <RaceEquivalence f={f} runs={runs} plan={plan} today={today} />}

        {/* Volume: what you ran, and what the plan has ahead. */}
        <section className="home-card home-volume">
          <header>
            <h3>Kilometres per week</h3>
            <span className="muted small">last 12 weeks · faint: the plan's next 8</span>
          </header>
          <BarChart bars={bars.bars} height={190} unit=" km" axis showValues={false} onBar={(i) => (i < bars.weeks.length ? openWeek(bars.weeks[i]) : undefined)} />
        </section>

        <section className="home-card home-runs">
          <header>
            <h3>Recent runs</h3>
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
                <th className="r">Time</th>
                <th className="r">Pace</th>
                <th className="r">HR</th>
                <th className="r">VO2</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} className="home-click" onClick={() => openRun(r.id)}>
                  <td className="nowrap">{r.date === today ? "Today" : fmt(r.date)}</td>
                  <td className="home-name">{r.name}</td>
                  <td className="r num">{(r.distance / 1000).toFixed(1)}</td>
                  <td className="r num">{duration(r.moving_time)}</td>
                  <td className="r num">{pace(r.distance, r.moving_time)}</td>
                  <td className="r num">{r.avg_hr ? Math.round(r.avg_hr) : "–"}</td>
                  <td className="r num">{est.has(r.id) ? est.get(r.id)!.toFixed(1) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="home-card home-preds">
          <header>
            <h3>Races</h3>
            <span className="muted small">{f?.predictions[0]?.source === "garmin" ? "Garmin" : "from your runs"} · change in 30 days</span>
          </header>
          <table className="home-table">
            <tbody>
              {(f?.predictions ?? []).map((p) => {
                const ch = p.seconds != null && p.monthAgoSeconds != null ? p.seconds - p.monthAgoSeconds : null;
                return (
                  <tr key={p.name}>
                    <td>{p.name}</td>
                    <td className="r num">
                      <b>{p.seconds != null ? duration(p.seconds) : "–"}</b>
                    </td>
                    <td className={"r num " + (ch == null ? "muted" : ch < 0 ? "up" : ch > 0 ? "down" : "muted")}>{ch == null ? "–" : `${ch <= 0 ? "−" : "+"}${duration(Math.abs(ch))}`}</td>
                    <td className="r num muted">{p.target ?? ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {races.length > 0 && (
            <>
              <h4>Coming up</h4>
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
      </div>

      {/* Health, one line. */}
      <button type="button" className="home-health" onClick={() => go("health")}>
        <span>
          Resting HR <b className="num">{h.rhr ? Math.round(h.rhr) : "–"}</b>
        </span>
        <span>
          HRV <b className="num">{h.hrv ? `${Math.round(h.hrv)} ms` : "–"}</b>
          {h.hrv_status ? <small> {h.hrv_status.toLowerCase()}</small> : null}
        </span>
        <span>
          Sleep <b className="num">{h.sleep_secs ? duration(h.sleep_secs).replace(/:\d\d$/, "") + " h" : "–"}</b>
          {h.sleep_score ? <small> score {h.sleep_score}</small> : null}
        </span>
        <span>
          Body battery <b className="num">{h.bb_high ?? "–"}</b>
        </span>
        <span>
          Readiness <b className="num">{h.readiness ?? "–"}</b>
        </span>
        <span className="home-link">Health ›</span>
      </button>
    </div>
  );
}
