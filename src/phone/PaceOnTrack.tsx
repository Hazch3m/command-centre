import { useMemo, useState } from "react";
import { kvGet, kvSet } from "../core/db";
import { notifyChanged, useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { useFitness } from "../modules/running/fitness";
import { IntervalChart, PaceBadge, usePaceChecks } from "../modules/running/PaceOnPoint";
import { fmtTarget, fmtVal } from "../modules/running/pace";
import { upcomingRaces, type Plan } from "../modules/running/plan";
import { fmtTime } from "../modules/running/pbs";
import { useReadiness } from "../modules/running/ReadinessCard";
import { raceDistance } from "../modules/running/readiness";
import type { Run } from "../modules/running/strava";
import { predictTime } from "../modules/running/vo2";
import { Section } from "./common";

const STANDARD = [
  { id: "5k", name: "5K", km: 5 },
  { id: "10k", name: "10K", km: 10 },
  { id: "half", name: "Half marathon", km: 21.0975 },
  { id: "marathon", name: "Marathon", km: 42.195 },
] as const;
const short = (name: string) => name.replace(/marathon/i, "Mara.").replace(/half Mara\./i, "Half");

/** Goals you set here for a distance (seconds), when a plan race doesn't give one. */
const loadGoals = () => kvGet<Record<string, number>>("running.paceGoals", {});

/** "3:05:00", "1:25", "19:30" → seconds (h:mm:ss, or mm:ss under an hour for short races). */
function parseTime(s: string, km: number): number | null {
  const p = s.trim().split(":").map(Number);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return km >= 21 ? p[0] * 3600 + p[1] * 60 : p[0] * 60 + p[1];
  return null;
}
const perKm = (secs: number, km: number) => {
  const s = Math.round(secs / km);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Like Runna's pace insights: where your fitness is now, where it's heading by race day and the
 * goal, for any of your races or a standard distance; then how close the runs were to their paces.
 */
export function PaceOnTrack({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const today = useToday();
  const f = useFitness(plan);
  const rv = useDataVersion("running");
  const goals = useQuery(loadGoals, [rv]).data ?? {};
  const races = upcomingRaces(plan, today);
  const main = races.find((r) => r.priority === "A") ?? races[0];
  const options = [
    ...races.slice(0, 4).map((r) => ({ id: `race:${r.date}:${r.name}`, label: short(r.name), race: r, km: raceDistance(r) })),
    ...STANDARD.map((s) => ({ id: s.id, label: s.name === "Half marathon" ? "Half" : s.name, race: null, km: s.km })),
  ];
  const [pick, setPick] = useState(options[0]?.id ?? "marathon");
  const opt = options.find((o) => o.id === pick) ?? options[0];
  // A standard distance is judged on the main race's date (or 12 weeks out).
  const race = useMemo(() => {
    if (opt.race) return opt.race;
    const name = STANDARD.find((s) => s.id === opt.id)!.name;
    const goal = goals[opt.id];
    return { date: main?.date ?? addDays(today, 84), name, km: opt.km, target: goal ? fmtTime(goal) : "", elevation: undefined };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opt.id, main?.date, goals[opt.id], today]);
  const r = useReadiness(plan, race);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const km = opt.km;
  const goal = r?.goal ?? (goals[opt.id] || null);

  // Your fitness week by week, as a time for this distance (lined up to "now" so the line ends where the card says).
  const history = useMemo(() => {
    if (!f || !r?.now) return [];
    const pts = f.weekly.filter((w) => w.smooth != null && w.week >= addDays(today, -7 * 20)).map((w) => ({ date: w.week, t: predictTime(km * 1000, w.smooth!) }));
    if (!pts.length) return [];
    const k = r.now / pts[pts.length - 1].t;
    return pts.map((p) => ({ ...p, t: p.t * k }));
  }, [f, r?.now, km, today]);

  const saveGoal = async () => {
    const s = parseTime(draft, km);
    const all = { ...goals };
    if (s) all[opt.id] = s;
    else delete all[opt.id];
    await kvSet("running.paceGoals", all);
    await notifyChanged("running");
    setEditing(false);
  };

  return (
    <>
      <div className="pt-picks" role="tablist" aria-label="Race or distance" data-noswipe>
        {options.map((o) => (
          <button key={o.id} role="tab" aria-selected={o.id === opt.id} className={o.id === opt.id ? "on" : ""} onClick={() => setPick(o.id)}>
            {o.race && <i aria-hidden="true">⚑</i>}
            {o.label}
          </button>
        ))}
      </div>

      {!r ? (
        <div className="p-card pt-card">
          <p className="p-hint">{f ? "Working it out…" : "Run a few times with heart rate (or enter a race) and your pace appears here."}</p>
        </div>
      ) : (
        <div className="p-card pt-card">
          <div className="pt-head">
            <span>
              <b>{opt.race ? opt.race.name : race.name}</b>
              <small>
                {parseKey(race.date!).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                {!opt.race && " · on your main race day"}
              </small>
            </span>
            <TrackTag now={r.now} predicted={r.predicted} goal={goal} />
          </div>

          <div className="pt-rows">
            <div className="pt-row pt-now-row">
              <small>Now</small>
              <b className="num">{r.now ? `${perKm(r.now, km)}/km` : "–"}</b>
              <span className="num">{r.now ? fmtTime(r.now) : ""}</span>
            </div>
            <div className="pt-row pt-day-row">
              <small>Race day</small>
              <b className="num">{r.predicted ? `${perKm(r.predicted, km)}/km` : "–"}</b>
              <span className="num">{r.range ? `${fmtTime(r.range[0])} – ${fmtTime(r.range[1])}` : r.predicted ? fmtTime(r.predicted) : ""}</span>
            </div>
            <div className="pt-row pt-goal-row">
              <small>Goal</small>
              {editing ? (
                <span className="pt-goal-edit">
                  <input autoFocus inputMode="numeric" placeholder={km >= 21 ? "h:mm:ss" : "mm:ss"} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveGoal()} />
                  <button className="btn small btn-primary" onClick={saveGoal}>
                    Save
                  </button>
                </span>
              ) : (
                <>
                  <b className="num">{goal ? `${perKm(goal, km)}/km` : "No goal"}</b>
                  <span className="num">
                    {goal ? fmtTime(goal) : ""}
                    {!opt.race && (
                      <button
                        className="pt-goal-btn"
                        onClick={() => {
                          setDraft(goal ? fmtTime(goal) : "");
                          setEditing(true);
                        }}
                      >
                        {goal ? "Change" : "Set a goal"}
                      </button>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>

          <TrackBar now={r.now} range={r.range} predicted={r.predicted} goal={goal} />
          <ProgressChart history={history} now={r.now} predicted={r.predicted} range={r.range} goal={goal} raceDate={race.date!} today={today} />
          <p className="p-hint">
            Current: a race today, from your recent running. Race day: where the plan should take you if you follow it.
          </p>
        </div>
      )}

      <PaceChecks plan={plan} runs={runs} />
    </>
  );
}

function TrackTag({ now, predicted, goal }: { now: number | null; predicted: number | null; goal: number | null }) {
  if (!goal || !predicted) return null;
  const gap = predicted - goal;
  const nowGap = now ? now - goal : null;
  const cls = nowGap != null && nowGap <= 0 ? "ahead" : gap <= 0 ? "on" : gap < goal * 0.015 ? "close" : "behind";
  const text = cls === "ahead" ? "Already there" : cls === "on" ? "On track" : cls === "close" ? `${fmtTime(gap)} off` : `${fmtTime(gap)} behind`;
  return <span className={`pt-tag ${cls}`}>{text}</span>;
}

/** Slower on the left, faster on the right: now, the race-day range and the goal on one line. Labels never overlap. */
function TrackBar({ now, range, predicted, goal }: { now: number | null; range: [number, number] | null; predicted: number | null; goal: number | null }) {
  const xs = [now, predicted, goal, ...(range ?? [])].filter((x): x is number => !!x);
  if (xs.length < 2) return null;
  const slow = Math.max(...xs) * 1.01;
  const fast = Math.min(...xs) * 0.99;
  const pos = (t: number) => ((slow - t) / (slow - fast)) * 100;
  const at = (t: number) => `${pos(t)}%`;
  // Labels: Now above, Race day below, Goal above; one that would overlap moves to the other side,
  // and two at the same spot share a label.
  const want: { id: string; text: string; x: number; slot: "up" | "down"; cls: string }[] = [];
  if (now) want.push({ id: "now", text: "Now", x: pos(now), slot: "up", cls: "now" });
  if (predicted) want.push({ id: "day", text: "Race day", x: pos(predicted), slot: "down", cls: "day" });
  if (goal) want.push({ id: "goal", text: "Goal", x: pos(goal), slot: "up", cls: "goal" });
  const placed: typeof want = [];
  const near = (a: number, b: number) => Math.abs(a - b) < 20;
  for (const l of want) {
    const other = l.slot === "up" ? "down" : "up";
    if (!placed.some((p) => p.slot === l.slot && near(p.x, l.x))) placed.push(l);
    else if (!placed.some((p) => p.slot === other && near(p.x, l.x))) placed.push({ ...l, slot: other });
    else {
      const p = placed.find((q) => near(q.x, l.x))!;
      p.text += ` · ${l.text}`;
    }
  }
  return (
    <div className="pt-bar" aria-hidden="true">
      <div className="pt-bar-line" />
      {range && <span className="pt-bar-range" style={{ left: at(range[1]), right: `calc(100% - ${at(range[0])})` }} />}
      {now && <span className="pt-bar-dot pt-dot-now" style={{ left: at(now) }} />}
      {predicted && <span className="pt-bar-dot pt-dot-day" style={{ left: at(predicted) }} />}
      {goal && <span className="pt-bar-flag" style={{ left: at(goal) }} />}
      {placed.map((l) => (
        <small key={l.id} className={`pt-bar-label ${l.slot} ${l.cls}` + (l.x < 12 ? " start" : l.x > 88 ? " end" : "")} style={{ left: `${l.x}%` }}>
          {l.text}
        </small>
      ))}
      <span className="pt-bar-ends">
        <small>Slower</small>
        <small>Faster</small>
      </span>
    </div>
  );
}

/** Your time for the distance over the last weeks, then the plan's path to race day and the goal line. Faster is up. */
function ProgressChart(p: { history: { date: string; t: number }[]; now: number | null; predicted: number | null; range: [number, number] | null; goal: number | null; raceDate: string; today: string }) {
  if (p.history.length < 2 || !p.now) return null;
  const W = 320;
  const H = 120;
  const t0 = parseKey(p.history[0].date).getTime();
  const t1 = parseKey(p.raceDate).getTime();
  const ts = [...p.history.map((h) => h.t), p.now, p.predicted ?? p.now, p.goal ?? p.now, ...(p.range ?? [])];
  const hi = Math.max(...ts) * 1.005;
  const lo = Math.min(...ts) * 0.995;
  const x = (d: string) => ((parseKey(d).getTime() - t0) / Math.max(1, t1 - t0)) * (W - 8) + 4;
  const y = (t: number) => 8 + ((t - lo) / (hi - lo)) * (H - 26);
  const line = p.history.map((h, i) => `${i ? "L" : "M"}${x(h.date).toFixed(1)} ${y(h.t).toFixed(1)}`).join("") + `L${x(p.today).toFixed(1)} ${y(p.now).toFixed(1)}`;
  const xr = x(p.raceDate);
  return (
    <svg className="pt-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Your time for this distance over recent weeks and to race day">
      {p.goal && (
        <>
          <line x1={0} x2={W} y1={y(p.goal)} y2={y(p.goal)} className="pt-goal-line" />
          <text x={4} y={y(p.goal) - 4} className="pt-axis">
            Goal {fmtTime(p.goal)}
          </text>
        </>
      )}
      {p.range && <path d={`M${x(p.today)} ${y(p.now)}L${xr} ${y(p.range[0])}L${xr} ${y(p.range[1])}Z`} className="pt-cone" />}
      {p.predicted && <line x1={x(p.today)} y1={y(p.now)} x2={xr} y2={y(p.predicted)} className="pt-proj" />}
      <path d={line} className="pt-line" />
      <circle cx={x(p.today)} cy={y(p.now)} r={4.5} className="pt-now" />
      {p.predicted && <circle cx={xr} cy={y(p.predicted)} r={4} className="pt-day" />}
      <text x={4} y={H - 3} className="pt-axis">
        {parseKey(p.history[0].date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
      </text>
      <text x={x(p.today)} y={H - 3} className="pt-axis" textAnchor="middle">
        Today
      </text>
      <text x={W - 4} y={H - 3} className="pt-axis" textAnchor="end">
        Race day
      </text>
    </svg>
  );
}

/** How close the runs were to their paces: the score, week by week, and each run. */
function PaceChecks({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const p = usePaceChecks(plan, runs, 12);
  if (!p) return null;
  return (
    <Section title="Pace on point" className="pt-checks">
      <div className="pt-score">
        <b className="num">{p.last14 ?? "–"}</b>
        <span>
          <small>% on point · last 14 days</small>
          How close each run was to the pace the plan asked for. Sessions are judged on the work only.
        </span>
      </div>
      {p.byWeek.length > 0 && (
        <div className="pt-weeks">
          {p.byWeek.slice(-8).map((w) => (
            <span key={w.week} className="pt-week">
              <i style={{ height: `${Math.max(6, w.score ?? 0)}%` }} className={(w.score ?? 0) >= 80 ? "good" : (w.score ?? 0) >= 60 ? "ok" : "low"} />
              <small>{parseKey(w.week).getDate()}</small>
            </span>
          ))}
        </div>
      )}
      {p.rows.length > 0 && (
        <div className="pt-ivchart" data-noswipe>
          <IntervalChart rows={p.rows} />
        </div>
      )}
      <div className="pt-list">
        {p.rows.slice(0, 12).map(({ day, check: c }) => (
          <div key={c.runId} className="pt-item">
            <span className="pt-item-main">
              <b>{day.text}</b>
              <small>
                {parseKey(c.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · target {fmtTarget(c)} · ran {fmtVal(c, c.actual)}
              </small>
            </span>
            <PaceBadge c={c} />
          </div>
        ))}
        {!p.rows.length && <p className="p-hint">Runs on planned days appear here once the plan starts.</p>}
      </div>
    </Section>
  );
}
