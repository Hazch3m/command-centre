import { useMemo, useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { forecastWeek, type ForecastDay } from "../modules/running/forecast";
import { mondayOf, upcomingRaces } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { typeOfDay } from "../modules/running/runType";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { useFitness } from "../modules/running/fitness";
import { latest as latestHealth, loadHealth } from "../modules/health/data";
import { useWeatherBrief } from "../modules/weather";
import { zoneOf } from "./EffortProfile";
import { sessionTitle, Today } from "./Today";
import { isEmptyPlan } from "../core/account";
import { openPlanDay } from "./WeekAhead";
import { usePhoneNav } from "./common";
import { useFocusBasis, weekFocus, FocusBar } from "./Focus";
import type { Run } from "../modules/running/strava";

/*
 * The website's Today: the week as seven day cards (planned, done, how it went), then three small
 * panels (weekly km, this morning, fitness) and your last runs. Drawn for a laptop screen.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayNum = (d: string) => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`;
const longDate = (d: string) => new Date(d + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
const kmOf = (runs: Run[]) => runs.reduce((a, r) => a + r.distance, 0) / 1000;
const paceOf = (runs: Run[]) => {
  const m = runs.reduce((a, r) => a + r.distance, 0);
  if (!m) return "";
  const s = runs.reduce((a, r) => a + r.moving_time, 0) / (m / 1000);
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}/km`;
};
const detailOf = (text: string) =>
  text
    .replace(/^\d+(?:\.\d+)?\s*km\s+(?:with\s+)?/i, "")
    .replace(/^(?:VO2 max|Threshold tempo|Threshold|Hill strength|Race pace):\s*/i, "")
    .replace(/^./, (c) => c.toUpperCase());

function DayCard({ d, today }: { d: ForecastDay; today: string }) {
  const nav = usePhoneNav();
  const rest = typeOfDay(d.kind) === "rest" || !d.km;
  const ran = d.runs.length > 0;
  const zone = ran && rest ? "easy" : rest ? "rest" : d.race ? "race" : zoneOf(d.text, d.kind);
  const isToday = d.date === today;
  const past = d.date < today;
  const title = d.race ? "Race day" : rest ? (ran ? "Extra run" : "Rest") : sessionTitle(d.text, d.kind);
  const tx0 = d.race ? `${d.race.name}${d.race.target ? `, aiming for ${d.race.target}` : ""}` : detailOf(d.text);
  // "Easy" under "Easy run" says nothing twice.
  const tx = title.toLowerCase().startsWith(tx0.toLowerCase().replace(/\s*run$/, "")) ? "" : tx0;
  const status = ran
    ? `Done · ${kmOf(d.runs).toFixed(1)} km, ${paceOf(d.runs)}`
    : isToday
      ? rest
        ? "Rest today"
        : "Today"
      : past && !rest
        ? "Missed"
        : "";
  return (
    <button
      type="button"
      className={`wt-day z-${zone}${isToday ? " today" : ""}${ran ? " done" : ""}${past && !ran && !rest ? " missed" : ""}`}
      onClick={() => (ran && d.runs.length === 1 ? openRun(d.runs[0].id) : openPlanDay(nav, d.date))}
    >
      <span className="wt-dn">
        <b>{DAYS[(new Date(d.date + "T12:00").getDay() + 6) % 7]}</b>
        <span>{dayNum(d.date)}</span>
      </span>
      <span className="wt-km num">{rest && !ran ? "Rest" : `${ran ? Math.round(kmOf(d.runs) * 10) / 10 : d.km} km`}</span>
      {!(rest && !ran) && <span className="wt-title">{title}</span>}
      {!rest && tx && <span className="wt-tx">{tx}</span>}
      {ran && !rest && d.km ? <span className="wt-plan num">Planned {d.km} km</span> : null}
      <span className={`wt-st${ran ? " ok" : past && !rest ? " miss" : ""}`}>{status}</span>
    </button>
  );
}

/** Weekly km as bars, the last 12 weeks, this week faded until it's done. */
function WeeklyKm({ runs, today }: { runs: Run[]; today: string }) {
  const weeks = useMemo(() => {
    const m0 = mondayOf(today);
    return Array.from({ length: 12 }, (_, i) => {
      const m = addDays(m0, (i - 11) * 7);
      const e = addDays(m, 6);
      return { m, km: kmOf(runs.filter((r) => r.date >= m && r.date <= e)) };
    });
  }, [runs, today]);
  const max = Math.max(20, ...weeks.map((w) => w.km));
  const step = max > 80 ? 40 : max > 40 ? 20 : 10;
  const top = Math.ceil(max / step) * step;
  const W = 480;
  const H = 150;
  const bw = (W - 34) / weeks.length;
  const y = (v: number) => H - 18 - (v / top) * (H - 30);
  return (
    <svg className="wt-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly km: ${weeks.map((w) => Math.round(w.km)).join(", ")}`}>
      {Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => (
        <g key={v}>
          <line x1={28} x2={W} y1={y(v)} y2={y(v)} className="wt-grid" />
          <text x={0} y={y(v) + 3.5}>{v}</text>
        </g>
      ))}
      {weeks.map((w, i) => (
        <g key={w.m}>
          <rect x={34 + i * bw + 3} y={y(w.km)} width={bw - 6} height={Math.max(0, y(0) - y(w.km))} rx={3} className={"wt-bar" + (i === weeks.length - 1 ? " now" : "")}>
            <title>{`Week of ${dayNum(w.m)}: ${w.km.toFixed(1)} km`}</title>
          </rect>
          {(i % 3 === 0 || i === weeks.length - 1) && (
            <text x={34 + i * bw + bw / 2} y={H - 3} textAnchor="middle">
              {i === weeks.length - 1 ? "Now" : dayNum(w.m)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/** VO2 max / VDOT, weekly, the last 16 weeks. */
function FitnessLine() {
  const { plan } = useRunningData();
  const f = useFitness(plan);
  const today = useToday();
  const pts = useMemo(() => {
    if (!f) return [];
    const from = addDays(today, -16 * 7);
    return f.weekly.filter((w) => w.week >= from && w.smooth != null).map((w) => ({ x: w.week, v: (w.smooth as number) + f.shift }));
  }, [f, today]);
  if (!f) return <p className="wt-empty">Working out your fitness…</p>;
  if (pts.length < 2) return <p className="wt-empty">Your fitness line appears after a few weeks of runs with heart rate.</p>;
  const lo = Math.floor(Math.min(...pts.map((p) => p.v)) - 0.5);
  const hi = Math.ceil(Math.max(...pts.map((p) => p.v)) + 0.5);
  const W = 340;
  const H = 150;
  const x = (i: number) => 30 + (i * (W - 36)) / (pts.length - 1);
  const y = (v: number) => H - 18 - ((v - lo) / (hi - lo)) * (H - 30);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const ticks = hi - lo <= 4 ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo, Math.round((lo + hi) / 2), hi];
  const last = pts[pts.length - 1];
  return (
    <svg className="wt-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Fitness ${last.v.toFixed(1)}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={26} x2={W} y1={y(v)} y2={y(v)} className="wt-grid" />
          <text x={0} y={y(v) + 3.5}>{v}</text>
        </g>
      ))}
      <path d={`${d} L${x(pts.length - 1)} ${y(lo)} L${x(0)} ${y(lo)}Z`} className="wt-area" />
      <path d={d} className="wt-line" />
      <circle cx={x(pts.length - 1)} cy={y(last.v)} r={4} className="wt-dot" />
      <text x={30} y={H - 3}>{dayNum(pts[0].x)}</text>
      <text x={W} y={H - 3} textAnchor="end">
        Now
      </text>
    </svg>
  );
}

function fmtSleep(s: number | null | undefined) {
  if (s == null) return "–";
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}`;
}

export function WebToday() {
  const today = useToday();
  const nav = usePhoneNav();
  const { plan, runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const [offset, setOffset] = useState(0);
  const monday = addDays(mondayOf(today), offset * 7);
  const fw = useMemo(() => (plan ? forecastWeek(plan, monday, runs, overrides) : null), [plan, monday, runs, overrides]);
  const race = plan ? upcomingRaces(plan, today)[0] : null;
  const hv = useDataVersion("health");
  const h = latestHealth(useQuery(() => loadHealth(3), [hv]).data ?? []);
  const w = useWeatherBrief();
  const b = useFocusBasis();
  const focus = useMemo(() => (fw && b.ready ? weekFocus(fw, today, b) : null), [fw, today, b]);
  const recent = useMemo(() => [...runs].filter((r) => r.date <= today).sort((a, c) => (a.start_local < c.start_local ? 1 : -1)).slice(0, 6), [runs, today]);

  // No plan yet (a new account): the phone's Today, with its getting-started steps.
  if (!fw || !plan || isEmptyPlan(plan)) return <Today />;
  const done = fw.days.filter((d) => d.date <= today && d.runs.length > 0 && typeOfDay(d.kind) !== "rest").length;
  const due = fw.days.filter((d) => d.date <= today && typeOfDay(d.kind) !== "rest" && d.km).length;
  const daysTo = race ? Math.round((new Date(race.date + "T12:00").getTime() - new Date(today + "T12:00").getTime()) / 864e5) : null;
  const weekLabel = fw.week ? `Week ${fw.week.week}${fw.week.phase ? ` · ${fw.week.phase}` : ""}` : "Outside your plan";
  const which = offset === 0 ? "This week" : offset === 1 ? "Next week" : offset === -1 ? "Last week" : `Week of ${dayNum(monday)}`;

  return (
    <div className="wt">
      <div className="wt-head">
        <div className="wt-titles">
          <h1>Today</h1>
          <span>{longDate(today)}</span>
        </div>
        <div className="wt-weeknav" role="group" aria-label="Week">
          <button type="button" onClick={() => setOffset(offset - 1)} aria-label="Earlier week">
            ‹
          </button>
          <button type="button" className="wt-which" onClick={() => setOffset(0)} disabled={offset === 0}>
            {which}
          </button>
          <button type="button" onClick={() => setOffset(offset + 1)} aria-label="Later week">
            ›
          </button>
        </div>
      </div>

      <div className="wt-sum">
        <span>
          <b className="num">{Math.round(fw.actualKm * 10) / 10}</b> of {fw.plannedKm != null ? <b className="num">{fw.plannedKm}</b> : "–"} km
        </span>
        <span className="wt-sum-mu">{weekLabel}</span>
        {race && daysTo != null && (
          <span className="wt-sum-mu">
            {race.name} in <b className="num">{daysTo}</b> {daysTo === 1 ? "day" : "days"}
          </span>
        )}
        {offset === 0 && due > 0 && (
          <span className={"wt-sum-st" + (done >= due ? " ok" : "")}>
            {done >= due ? "On track: " : ""}
            {done} of {due} sessions done
          </span>
        )}
      </div>

      <div className="wt-week">
        {fw.days.map((d) => (
          <DayCard key={d.date} d={d} today={today} />
        ))}
      </div>

      <div className="wt-row">
        <section className="wt-panel">
          <h2>Weekly km, 12 weeks</h2>
          <WeeklyKm runs={runs} today={today} />
        </section>
        <section className="wt-panel">
          <h2>This morning</h2>
          <div className="wt-kv">
            <button type="button" onClick={() => nav.push("health")}>
              <small>Sleep</small>
              <b className="num">{fmtSleep(h.sleep_secs)}</b>
            </button>
            <button type="button" onClick={() => nav.push("health")}>
              <small>HRV</small>
              <b className="num">{h.hrv != null ? `${Math.round(h.hrv)} ms` : "–"}</b>
            </button>
            <button type="button" onClick={() => nav.push("health")}>
              <small>Resting HR</small>
              <b className="num">{h.rhr != null ? Math.round(h.rhr) : "–"}</b>
            </button>
            <button type="button" onClick={() => nav.push("weather")}>
              <small>Weather</small>
              <b className="num">{w ? `${w.temp}° ${w.text}` : "–"}</b>
            </button>
          </div>
          {focus && (
            <div className="wt-focus">
              <h2>Load focus {offset > 0 ? "planned" : "this week"}</h2>
              <FocusBar mix={focus.share} compact />
            </div>
          )}
        </section>
        <section className="wt-panel">
          <h2>Fitness</h2>
          <FitnessLine />
        </section>
      </div>

      <section className="wt-panel">
        <h2>Last runs</h2>
        {recent.length ? (
          <table className="wt-runs">
            <thead>
              <tr>
                <th>Date</th>
                <th>Run</th>
                <th className="r">km</th>
                <th className="r">Time</th>
                <th className="r">Pace</th>
                <th className="r">HR</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id} onClick={() => openRun(r.id)}>
                  <td className="num">
                    {DAYS[(new Date(r.date + "T12:00").getDay() + 6) % 7]} {dayNum(r.date)}
                  </td>
                  <td>{r.name}</td>
                  <td className="r num">{(r.distance / 1000).toFixed(1)}</td>
                  <td className="r num">{`${Math.floor(r.moving_time / 3600) ? Math.floor(r.moving_time / 3600) + ":" : ""}${String(Math.floor((r.moving_time % 3600) / 60)).padStart(Math.floor(r.moving_time / 3600) ? 2 : 1, "0")}:${String(r.moving_time % 60).padStart(2, "0")}`}</td>
                  <td className="r num">{paceOf([r])}</td>
                  <td className="r num">{r.avg_hr ? Math.round(r.avg_hr) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="wt-empty">Your runs appear here once you've connected Garmin, Strava or Apple Health.</p>
        )}
      </section>
    </div>
  );
}
