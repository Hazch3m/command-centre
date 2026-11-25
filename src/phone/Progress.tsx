import { useMemo, type ReactNode } from "react";
import { addDays, diffDays, parseKey, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { isEmptyPlan } from "../core/account";
import { useFitness, type Fitness } from "../modules/running/fitness";
import { fmtPace, type PaceCheck } from "../modules/running/pace";
import type { ForecastDay } from "../modules/running/forecast";
import { usePaceChecks } from "../modules/running/PaceOnPoint";
import { mondayOf, priorityOf, type Plan, type PlanRace } from "../modules/running/plan";
import { fmtTime } from "../modules/running/pbs";
import { aerobicTrend, consistency, consistencySummary, sessionChange, sessionKind, type SessionKind, type SessionPoint } from "../modules/running/progression";
import { useReadiness } from "../modules/running/ReadinessCard";
import { openRun } from "../modules/running/RunView";
import { raceHistory } from "../modules/running/stats";
import { loadOverrides, type Run } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { vdot } from "../modules/running/vo2";
import { Section, usePhoneNav } from "./common";
import { WellnessTrend } from "./WellnessTrend";

/*
 * Progress: four questions, each answered with one number, its trend and the runs behind it.
 *   On track?        the goal race: if you raced today, race day if you follow the plan, the goal
 *   Getting fitter?  one fitness number (VDOT from your races and hard sessions), with Garmin as a cross-check
 *   What's improving? easy pace at a fixed heart rate (the aerobic engine) and your sessions' pace for the heart rate
 *   Is it happening, and are you absorbing it? planned vs done, sessions hit, resting HR and HRV
 * The raw model numbers (training load, zones, the fitness model, the run table) are one tap away, under Details.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const signed = (x: number, digits = 0) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(digits)}`;

export function Progress() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const nav = usePhoneNav();
  if (!plan || isEmptyPlan(plan) || !f)
    return (
      <div className="p-screen">
        <section className="p-start">
          <h2>Your progress shows here</h2>
          <p className="p-start-note">Once your runs come in from Garmin or Strava: your fitness and where it's heading, whether you're on track for your race, and what's improving.</p>
        </section>
      </div>
    );
  return (
    <div className="p-screen pg">
      <GoalCard plan={plan} f={f} today={today} />
      <FitnessCard f={f} today={today} />
      <AerobicCard runs={runs} f={f} today={today} />
      <SessionsCard plan={plan} runs={runs} />
      <ConsistencyCard plan={plan} runs={runs} today={today} />
      <WellnessTrend card />
      <RacesCard plan={plan} runs={runs} f={f} onPbs={() => nav.push("pbs")} />
      <Section title="Details" className="pg-details">
        <div className="p-group">
          <Row title="Race readiness and pace targets" sub="Each race: ready if it were today, on race day, and the pace to aim for" onClick={() => nav.push("goals")} />
          <Row title="Training load and zones" sub="Fitness, fatigue and form, load focus, heart-rate zones" onClick={() => nav.push("load")} />
          <Row title="Fitness model" sub="Every estimate, Garmin's VO2 max, the path to your goals, marathon shape" onClick={() => nav.push("fitness")} />
          <Row title="Health" sub="Readiness, HRV, sleep and resting heart rate, day by day" onClick={() => nav.push("health")} />
          <Row title="Run table" sub="Week by week: every run with its pace and heart-rate zones" onClick={() => nav.push("analysis")} />
        </div>
      </Section>
    </div>
  );
}

function Row({ title, sub, onClick }: { title: string; sub: string; onClick: () => void }) {
  return (
    <button className="p-row p-row-btn" onClick={onClick}>
      <span className="p-row-main">
        <span className="p-row-title">{title}</span>
        <span className="p-row-sub">{sub}</span>
      </span>
      <span className="p-chev">›</span>
    </button>
  );
}

function Card({ title, lead, children, className = "" }: { title: string; lead?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <section className={"pg-card " + className}>
      <h2>{title}</h2>
      {lead && <p className="pg-lead">{lead}</p>}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// On track?

function goalRace(plan: Plan, today: string): PlanRace | null {
  const a = plan.races.filter((r) => r.date && r.date >= today && r.target && priorityOf(r) === "A").sort((x, y) => x.date!.localeCompare(y.date!));
  if (a.length) return a[0];
  const b = plan.built?.raceDate ? plan.races.find((r) => r.date === plan.built!.raceDate) : null;
  return b ?? null;
}

function GoalCard({ plan, f, today }: { plan: Plan; f: Fitness; today: string }) {
  const race = goalRace(plan, today);
  const r = useReadiness(plan, race);
  if (!race || !r) return null;
  const weeks = Math.ceil(diffDays(today, race.date!) / 7);
  const gap = r.predicted != null && r.goal != null ? r.predicted - r.goal : null;
  const perKm = gap != null ? gap / r.distanceKm : null;
  const tone = gap == null ? "" : gap <= 0 ? "good" : perKm! <= 3 ? "amber" : "warn";
  const verdict = gap == null ? "No goal time set" : gap <= 0 ? "On course for your goal" : perKm! <= 3 ? `Close: ${fmtTime(gap)} to find` : `Behind: ${fmtTime(gap)} to find`;
  return (
    <section className={"pg-card pg-goal tone-" + tone}>
      <div className="pg-goal-head">
        <h2>{race.name}</h2>
        <span className="muted">
          {day(race.date!)} · {weeks} weeks
        </span>
      </div>
      <p className="pg-verdict">{verdict}</p>
      <div className="pg-trio">
        <span>
          <small>If you raced today</small>
          <b className="num">{r.now ? fmtTime(r.now) : "–"}</b>
        </span>
        <span className="hl">
          <small>Race day, following the plan</small>
          <b className="num">{r.predicted ? fmtTime(r.predicted) : "–"}</b>
          {r.range && <i className="num">{`${fmtTime(r.range[0])}–${fmtTime(r.range[1])}`}</i>}
        </span>
        <span>
          <small>Goal</small>
          <b className="num">{r.goal ? fmtTime(r.goal) : race.target || "–"}</b>
        </span>
      </div>
      <p className="pg-note">
        {gap != null && gap > 0 && perKm != null && <>That's {Math.round(perKm)} s/km. </>}
        {f.slope != null && <>Fitness is {f.slope >= 0 ? "rising" : "falling"} {Math.abs(f.slope).toFixed(2)} VDOT a week over the last 8 weeks. </>}
        Race readiness {r.score}%: how much of the volume, long runs and race-specific work the plan has in you by then.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Getting fitter?

function FitnessCard({ f, today }: { f: Fitness; today: string }) {
  const from = addDays(today, -364);
  const pts = f.weekly.filter((w) => w.week >= from && w.smooth != null).map((w) => ({ d: w.week, v: w.smooth! }));
  const races = f.races.filter((r) => r.date >= from);
  const now = f.current;
  const then = pts.find((p) => p.d >= addDays(today, -91))?.v ?? null;
  // The level your goal race needs (its milestone), drawn as a line; nothing else ahead of today.
  const goal = f.config.projection.milestones.filter((m) => m.date >= today).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  const ms = goal ? { ...goal, label: goal.label.replace(/^.*·\s*/, "") } : null;
  if (now == null && !pts.length) return null;
  // The chart: the last year and on to the next goal.
  const end = today;
  const W = 320;
  const H = 120;
  const vals = [...pts.map((p) => p.v), ...races.map((r) => r.vdot), ...(ms ? [ms.vo2] : []), ...(now != null ? [now] : [])];
  const lo = Math.floor(Math.min(...vals) - 1);
  const hi = Math.ceil(Math.max(...vals) + 1);
  const span = Math.max(1, diffDays(from, end));
  const x = (d: string) => (diffDays(from, d) / span) * W;
  const y = (v: number) => 6 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 12);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");
  const months: { d: string; label: string }[] = [];
  for (let d = addDays(from, 1); d <= end; d = addDays(d, 1)) if (parseKey(d).getDate() === 1 && parseKey(d).getMonth() % 2 === 0) months.push({ d, label: MON[parseKey(d).getMonth()] });
  if (now != null && pts.length) pts.push({ d: today, v: now });
  const basis = f.predictionBasis?.race;
  return (
    <Card
      title="Fitness"
      lead={
        <>
          <b className="pg-big num">{now != null ? now.toFixed(1) : "–"}</b> VDOT
          {then != null && now != null && <span className={"pg-delta " + (now - then >= 0 ? "up" : "down")}>{signed(now - then, 1)} in 3 months</span>}
        </>
      }
    >
      <svg className="pg-chart" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={`Fitness VDOT ${now?.toFixed(1)}`}>
        {ms && <line x1={0} x2={W} y1={y(ms.vo2)} y2={y(ms.vo2)} className="pg-goal-line" />}
        {ms && (
          <text x={2} y={y(ms.vo2) - 3} className="pg-axis">
            {ms.label} needs {ms.vo2.toFixed(1)}
          </text>
        )}
        <path d={line} className="pg-line" />
        {races.map((r) => (
          <rect key={r.date + r.name} x={x(r.date) - 3.5} y={y(r.vdot) - 3.5} width={7} height={7} transform={`rotate(45 ${x(r.date)} ${y(r.vdot)})`} className="pg-race">
            <title>{`${r.name}, ${day(r.date)}: VDOT ${r.vdot.toFixed(1)}`}</title>
          </rect>
        ))}
        {months.map((m) => (
          <text key={m.d} x={x(m.d)} y={H + 12} className="pg-axis">
            {m.label}
          </text>
        ))}
      </svg>
      <p className="pg-note">
        From your races (◆) and the pace and heart rate of your hard sessions{basis ? `; latest race ${basis.name}, ${day(basis.date)}: ${basis.vdot.toFixed(1)}` : ""}.
        {f.garmin && <> Garmin's VO2 max says {f.garmin.latest.vo2.toFixed(0)} on its own scale ({signed(f.garmin.offset, 1)} from this one).</>}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// What's improving? The aerobic engine

function AerobicCard({ runs, f, today }: { runs: Run[]; f: Fitness; today: string }) {
  const t = useMemo(() => aerobicTrend(runs, f.config.hrMax, today), [runs, f.config.hrMax, today]);
  if (t.points.length < 2) return null;
  const first = t.points[0];
  const last = t.points[t.points.length - 1];
  const d = last.pace - first.pace;
  const W = 320;
  const H = 90;
  const ps = t.points.map((p) => p.pace);
  const lo = Math.min(...ps) - 5;
  const hi = Math.max(...ps) + 5;
  const bw = W / t.points.length;
  // Quicker is better: taller bars for quicker paces.
  const h = (p: number) => 10 + ((hi - p) / Math.max(1, hi - lo)) * (H - 22);
  return (
    <Card
      title="Aerobic engine"
      lead={
        <>
          <b className="pg-big num">{fmtPace(last.pace)}</b>/km at {t.ref} bpm
          <span className={"pg-delta " + (d <= 0 ? "up" : "down")}>
            {d <= 0 ? `${fmtPace(-d).replace(/^0:/, "")} s/km quicker` : `${fmtPace(d).replace(/^0:/, "")} s/km slower`} than {MON[+first.month.slice(5) - 1]}
          </span>
        </>
      }
    >
      <svg className="pg-chart" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="Easy pace at a fixed heart rate, month by month">
        {t.points.map((p, i) => (
          <g key={p.month}>
            <rect x={i * bw + bw * 0.18} width={bw * 0.64} y={H - h(p.pace)} height={h(p.pace)} rx={3} className="pg-bar">
              <title>{`${MON[+p.month.slice(5) - 1]}: ${fmtPace(p.pace)}/km at ${t.ref} bpm (${p.runs} runs)`}</title>
            </rect>
            <text x={i * bw + bw / 2} y={H - h(p.pace) - 3} textAnchor="middle" className="pg-val">
              {fmtPace(p.pace)}
            </text>
            <text x={i * bw + bw / 2} y={H + 12} textAnchor="middle" className="pg-axis">
              {MON[+p.month.slice(5) - 1]}
            </text>
          </g>
        ))}
      </svg>
      <p className="pg-note">Your easy runs' pace for the heart rate, as if every one were run at {t.ref} bpm (flat runs of 6 km or more). Quicker for the same heart rate means a bigger aerobic engine: it's the base the marathon is built on.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// What's improving? Sessions

const KINDS: SessionKind[] = ["Threshold", "VO2 max", "10k pace", "Marathon pace"];

function SessionsCard({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const checks = usePaceChecks(plan, runs, 26);
  const points: SessionPoint[] = useMemo(
    () =>
      (checks?.rows ?? [])
        .filter((r) => r.check.session && r.check.unit !== "bpm")
        .flatMap((r) => {
          const kind = sessionKind(r.day.text);
          return kind ? [{ r, kind }] : [];
        })
        .map(({ r, kind }: { r: { day: ForecastDay; check: PaceCheck }; kind: SessionKind }): SessionPoint => ({
          date: r.check.date,
          runId: r.check.runId,
          kind,
          label: r.check.autoZone ? r.day.text.replace(/\s*\(before the plan.*$/, "") : (/(?:Threshold|VO2 max|10K pace|5K pace|Marathon pace):\s*([^,]+)/.exec(r.day.text)?.[1] ?? r.day.text).replace(/ at .*$/, ""),
          pace: r.check.actual,
          target: r.check.target,
          hr: r.check.hr ?? null,
          onTarget: r.check.verdict === "on-point",
        })),
    [checks],
  );
  if (!points.length) return null;
  const recent = [...points].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const changes = KINDS.map((k) => ({ k, c: sessionChange(points, k) })).filter((x) => x.c);
  const hit = points.filter((p) => p.onTarget).length;
  return (
    <Card title="Sessions" lead={<>{hit} of {points.length} sessions on target in the last 6 months</>}>
      {changes.length > 0 && (
        <div className="pg-changes">
          {changes.map(({ k, c }) => (
            <div key={k} className="pg-change">
              <b>{k}</b>
              <span className="num">
                {fmtPace(c!.last.pace)}/km{c!.last.hr ? ` at ${Math.round(c!.last.hr)} bpm` : ""}
              </span>
              <small className={c!.pace <= 0 ? "up" : "down"}>
                {c!.pace <= 0 ? `${Math.round(-c!.pace)} s/km quicker` : `${Math.round(c!.pace)} s/km slower`}
                {c!.hr != null ? `, ${c!.hr <= 0 ? `${Math.round(-c!.hr)} bpm lower` : `${Math.round(c!.hr)} bpm higher`}` : ""} than {day(c!.first.date)}
              </small>
            </div>
          ))}
        </div>
      )}
      <ul className="pg-sessions">
        {recent.map((p) => (
          <li key={p.runId}>
            <button onClick={() => openRun(p.runId)}>
              <span className="pg-s-date">{day(p.date)}</span>
              <span className="pg-s-what">
                <em>{p.kind}</em> {p.label}
              </span>
              <span className="pg-s-num num">
                {fmtPace(p.pace)}
                {p.hr ? <i> · {Math.round(p.hr)}</i> : null}
              </span>
              <span className={"pg-dot " + (p.onTarget ? "ok" : "off")} title={p.onTarget ? "On target" : `Target ${fmtPace(p.target[0])}–${fmtPace(p.target[1])}`} />
            </button>
          </li>
        ))}
      </ul>
      <p className="pg-note">The work only (reps, not the warm-up and jogs), with its heart rate where the watch laps have it. Quicker for the same heart rate, or the same pace for less, is progress.</p>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Is it happening?

function ConsistencyCard({ plan, runs, today }: { plan: Plan; runs: Run[]; today: string }) {
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const ws = useMemo(() => consistency(plan, runs, today, 12, overrides), [plan, runs, today, overrides]);
  const s = consistencySummary(ws, today);
  const W = 320;
  const H = 90;
  const top = Math.max(10, ...ws.map((w) => Math.max(w.done, w.planned ?? 0)));
  const bw = W / ws.length;
  const y = (v: number) => H - (v / top) * (H - 8);
  return (
    <Card
      title="Training"
      lead={
        s.avg4 != null ? (
          <>
            <b className="pg-big num">{Math.round(s.avg4)}</b> km a week{s.planned4 ? <> of {Math.round(s.planned4)} planned</> : null}, last 4 weeks
          </>
        ) : null
      }
    >
      <svg className="pg-chart" viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label="Kilometres each week against the plan">
        {ws.map((w, i) => (
          <g key={w.monday}>
            {w.planned != null && <rect x={i * bw + bw * 0.12} width={bw * 0.76} y={y(w.planned)} height={H - y(w.planned)} rx={3} className="pg-planned" />}
            <rect x={i * bw + bw * 0.24} width={bw * 0.52} y={y(w.done)} height={H - y(w.done)} rx={3} className={"pg-done" + (w.monday === mondayOf(today) ? " now" : "")}>
              <title>{`Week of ${day(w.monday)}: ${Math.round(w.done)} km${w.planned ? ` of ${Math.round(w.planned)}` : ""}`}</title>
            </rect>
            {i % 3 === 0 && (
              <text x={i * bw + bw / 2} y={H + 12} textAnchor="middle" className="pg-axis">
                {day(w.monday)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="pg-stats">
        <span>
          <b className="num">{s.kmShare != null ? `${Math.round(s.kmShare * 100)}%` : "–"}</b>
          <small>of planned km, {s.weeks} weeks</small>
        </span>
        <span>
          <b className="num">{s.keysPlanned ? `${s.keysDone} of ${s.keysPlanned}` : "–"}</b>
          <small>sessions done</small>
        </span>
        <span>
          <b className="num">{s.longest ? `${Math.round(s.longest)} km` : "–"}</b>
          <small>longest run, 8 weeks</small>
        </span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Races

function RacesCard({ plan, runs, f, onPbs }: { plan: Plan; runs: Run[]; f: Fitness; onPbs: () => void }) {
  const rows = useMemo(() => raceHistory(runs, plan, f.config.hrMax).slice(-6).reverse(), [runs, plan, f.config.hrMax]);
  if (!rows.length) return null;
  return (
    <Card title="Races">
      <ul className="pg-races">
        {rows.map((r) => (
          <li key={r.id}>
            <button onClick={() => openRun(r.id)}>
              <span className="pg-s-date">{day(r.date)}</span>
              <span className="pg-s-what">{r.name}</span>
              <span className="pg-s-num num">{fmtTime(r.time)}</span>
              <span className="pg-s-vdot num">{vdot(r.km * 1000, r.time).toFixed(1)}</span>
            </button>
          </li>
        ))}
      </ul>
      <button className="p-link" onClick={onPbs}>
        All personal bests ›
      </button>
    </Card>
  );
}

/** The answers in brief, for Today on a computer: the goal, fitness and the aerobic engine, with a link to Progress. */
export function ProgressSummary({ plan, onOpen }: { plan: Plan; onOpen: () => void }) {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const f = useFitness(plan);
  const race = goalRace(plan, today);
  const r = useReadiness(plan, race);
  const aero = useMemo(() => (f ? aerobicTrend(runs, f.config.hrMax, today) : null), [runs, f, today]);
  if (!f) return null;
  const gap = r?.predicted != null && r.goal != null ? r.predicted - r.goal : null;
  const then = f.weekly.find((w) => w.week >= addDays(today, -91) && w.smooth != null)?.smooth ?? null;
  const a0 = aero?.points[0];
  const a1 = aero?.points[aero.points.length - 1];
  return (
    <button type="button" className="pg-sum" onClick={onOpen}>
      {race && r && (
        <span className="pg-sum-row">
          <small>{race.name}, race day</small>
          <b className="num">{r.predicted ? fmtTime(r.predicted) : "–"}</b>
          <i className={gap == null ? "" : gap <= 0 ? "up" : "down"}>{gap == null ? "" : gap <= 0 ? "on course" : `${fmtTime(gap)} off the goal`}</i>
        </span>
      )}
      <span className="pg-sum-row">
        <small>Fitness</small>
        <b className="num">{f.current != null ? f.current.toFixed(1) : "–"}</b>
        <i className={then != null && f.current != null && f.current >= then ? "up" : "down"}>{then != null && f.current != null ? `${signed(f.current - then, 1)} in 3 months` : ""}</i>
      </span>
      {a0 && a1 && a0 !== a1 && (
        <span className="pg-sum-row">
          <small>Easy pace at {aero!.ref} bpm</small>
          <b className="num">{fmtPace(a1.pace)}</b>
          <i className={a1.pace <= a0.pace ? "up" : "down"}>
            {Math.round(Math.abs(a1.pace - a0.pace))} s/km {a1.pace <= a0.pace ? "quicker" : "slower"} since {MON[+a0.month.slice(5) - 1]}
          </i>
        </span>
      )}
      <span className="p-link">Progress ›</span>
    </button>
  );
}
