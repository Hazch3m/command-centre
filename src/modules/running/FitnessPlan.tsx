import { useEffect, useMemo, useState } from "react";
import { kvGet, kvSet } from "../../core/db";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { BarChart, LineChart } from "../../shell/charts";
import { loadHealth, type HealthDay } from "../health/data";
import { marathonShape, SHAPE_DEFAULTS, showVo2, type Fitness, type ShapeOptions } from "./fitness";
import { forecastWeek } from "./forecast";
import { mondayOf, type Plan } from "./plan";
import { ShapeBar } from "./Predictions";
import { duration } from "./stats";
import type { Run } from "./strava";
import { predictTime, vdot } from "./vo2";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDate = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]} ${String(parseKey(d).getFullYear()).slice(2)}`;
const monthLabel = (d: string) => `${MON[parseKey(d).getMonth()]} ${String(parseKey(d).getFullYear()).slice(2)}`;
const hmm = (s: number) => {
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};
const days = (a: string, b: string) => (parseKey(b).getTime() - parseKey(a).getTime()) / 86400000;

interface Goal {
  date: string;
  label: string;
  seconds: number; // marathon
}

/**
 * The marathon time you need on each date to be on course for the goals,
 * changing at a steady rate of speed from where you started, through
 * sub-2:50 at Edinburgh, to sub-2:45 at Valencia.
 */
export function goalPath(start: { date: string; seconds: number }, goals: Goal[]) {
  const pts = [{ date: start.date, seconds: start.seconds }, ...goals.filter((g) => g.date > start.date).sort((a, b) => a.date.localeCompare(b.date))];
  return (date: string): number => {
    if (date <= pts[0].date) return pts[0].seconds;
    for (let i = 1; i < pts.length; i++)
      if (date <= pts[i].date) {
        const f = days(pts[i - 1].date, date) / days(pts[i - 1].date, pts[i].date);
        const v = 1 / pts[i - 1].seconds + f * (1 / pts[i].seconds - 1 / pts[i - 1].seconds); // speed, linearly
        return 1 / v;
      }
    return pts[pts.length - 1].seconds;
  };
}

function useHealthHistory() {
  const v = useDataVersion("health");
  return useQuery(() => loadHealth(420).catch(() => [] as HealthDay[]), [v]).data ?? [];
}

const DISTS = [
  { name: "5k", m: 5000, key: "pred_5k" },
  { name: "10k", m: 10000, key: "pred_10k" },
  { name: "Half", m: 21097.5, key: "pred_half" },
  { name: "Marathon", m: 42195, key: "pred_marathon" },
] as const;

/** Goal path: what you need to be running, month by month, to run 2:50 then 2:45, and how you're doing. */
export function GoalPath({ f }: { f: Fitness }) {
  const today = useToday();
  const health = useHealthHistory();
  const [dist, setDist] = useState<(typeof DISTS)[number]["name"]>("Marathon");
  const goals: Goal[] = f.config.projection.milestones.map((m) => ({ date: m.date, label: m.label, seconds: Math.round(predictTime(42195, m.vo2) / 60) * 60 }));
  const final = [...goals].sort((a, b) => b.date.localeCompare(a.date))[0];

  const model = useMemo(() => {
    const now = Object.fromEntries(f.predictions.map((p) => [p.name, p.seconds])) as Record<string, number | null>;
    if (!now.Marathon || !final) return null;
    // Anchor: the prediction at the projection's start date (once it has passed), else today.
    const startDate = f.config.projection.start.date < today ? f.config.projection.start.date : today;
    const atStart = health.filter((h) => h.pred_marathon != null && h.date <= startDate).pop() ?? null;
    const base: Record<string, number> = {};
    for (const d of DISTS) base[d.name] = (atStart?.[d.key] as number | null) ?? now[d.name] ?? predictTime(d.m, vdot(42195, now.Marathon));
    const path = goalPath({ date: startDate, seconds: base.Marathon }, goals);
    const required = (dist: string, date: string) => base[dist] * (path(date) / base.Marathon);
    const vo2At = (date: string) => f.project(date);
    // Actual marathon predictions over time (Garmin's history when synced).
    const actual = health.filter((h) => h.pred_marathon != null).map((h) => ({ date: h.date, m: h.pred_marathon!, h }));
    return { base, path, required, vo2At, actual, startDate, now };
  }, [f, health, today, final?.date]);

  if (!final) return <p className="muted">Set a goal time for your goal race (Plan → Your plan → Races, or when you build a plan) to see the path to it here.</p>;
  if (!model) return <p className="muted">Needs a marathon prediction first: a race result (any distance), Garmin's race predictions, or one you enter under Race fitness.</p>;
  const { required, startDate, now } = model;
  const key = DISTS.find((x) => x.name === dist)!.key;
  const series = health.filter((h) => h[key] != null).map((h) => ({ date: h.date, m: h[key] as number }));
  const needAt = (d: string) => required(dist, d);
  const from = addDays(today, -120) < startDate ? addDays(today, -120) : startDate;

  // Month-end checkpoints from the start to the final goal.
  const checkpoints: string[] = [];
  for (let d = startDate; d <= final.date; ) {
    const x = parseKey(d);
    const end = new Date(x.getFullYear(), x.getMonth() + 1, 0);
    const key = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    checkpoints.push(key > final.date ? final.date : key);
    d = addDays(key, 1);
  }
  const actualAt = (date: string) => series.filter((a) => a.date <= date && a.date > addDays(date, -10)).pop() ?? null;
  const nowM = now[dist] ?? required(dist, today);
  const reqNow = needAt(today);
  const onTrack = nowM <= reqNow + 5;

  return (
    <>
      <p className="lead">
        To run <b>{hmm(final.seconds)}</b> at {final.label.split(" · ")[1] ?? "the goal race"} ({fmtDate(final.date)}), your {dist === "Marathon" ? "marathon" : dist} prediction needs to come down
        steadily from {duration(model.base[dist])} ({fmtDate(startDate)}) to {duration(required(dist, final.date))}. Today it should be <b>{duration(reqNow)}</b>; it's <b className={onTrack ? "tone-accent" : "tone-danger"}>{duration(nowM)}</b>{" "}
        ({onTrack ? "on track" : `${duration(nowM - reqNow)} behind`}).
      </p>
      <div className="goal-targets">
        {goals.map((g) => (
          <div key={g.date} className="goal-card">
            <div className="label">{g.label}</div>
            <div className="muted small">{fmtDate(g.date)} · you need about</div>
            <table className="pred-table">
              <tbody>
                {DISTS.map((d) => (
                  <tr key={d.name}>
                    <th>{d.name}</th>
                    <td className="num-col num">
                      <b>{duration(required(d.name, g.date))}</b>
                    </td>
                    <td className="num-col small muted">now {now[d.name] ? duration(now[d.name]!) : "–"}</td>
                  </tr>
                ))}
                <tr>
                  <th>VO2 max</th>
                  <td className="num-col num">
                    <b>{showVo2(f, g.date ? f.config.projection.milestones.find((m) => m.date === g.date)?.vo2 : null)}</b>
                  </td>
                  <td className="num-col small muted">now {showVo2(f, f.current)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="goal-bar">
        <h3>{dist} prediction against the path</h3>
        <div className="segmented small-seg">
          {DISTS.map((d) => (
            <button key={d.name} className={dist === d.name ? "on" : ""} onClick={() => setDist(d.name)}>
              {d.name}
            </button>
          ))}
        </div>
      </div>
      <LineChart
        from={from}
        to={final.date}
        height={220}
        today={today}
        format={dist === "Marathon" || dist === "Half" ? hmm : (v: number) => duration(v)}
        markers={goals.map((g) => ({ x: g.date, label: g.label.split(" · ")[0] }))}
        series={[
          { name: "Needed", kind: "dashed", className: "s-proj", points: checkpoints.map((d) => ({ x: d, y: needAt(d) })).concat([{ x: startDate, y: needAt(startDate) }]).sort((a, b) => a.x.localeCompare(b.x)) },
          { name: f.predictions.some((p) => p.source === "garmin") ? "Garmin prediction" : "Prediction", kind: "line", className: "s-trend", points: series.map((a) => ({ x: a.date, y: a.m })) },
          { name: "Now", kind: "dots", className: "s-est", points: [{ x: today, y: nowM }] },
        ]}
      />
      <p className="muted small">
        The dashed line is the prediction you need on each date, improving at a steady rate of speed through each goal. Under the line is ahead of plan. It fills in every day from
        Garmin's predictor.
      </p>

      <h3>Month by month</h3>
      <table className="table">
        <thead>
          <tr>
            <th>End of</th>
            <th className="num-col">Marathon needed</th>
            <th className="num-col">Half needed</th>
            <th className="num-col">10k needed</th>
            <th className="num-col">VO2 max needed</th>
            <th className="num-col">Your {dist === "Marathon" ? "marathon" : dist}</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {checkpoints.map((d) => {
            const a = d <= today ? actualAt(d) : d === checkpoints.find((c) => c >= today) ? { m: nowM } : null;
            const need = needAt(d);
            const st = a ? (a.m <= need + 5 ? "ok" : "behind") : "to come";
            return (
              <tr key={d} className={d < today ? "row-past" : ""}>
                <td>{monthLabel(d)}</td>
                <td className="num-col">{duration(need)}</td>
                <td className="num-col">{duration(required("Half", d))}</td>
                <td className="num-col">{duration(required("10k", d))}</td>
                <td className="num-col">{showVo2(f, f.project(d))}</td>
                <td className="num-col">{a ? duration(a.m) : "–"}</td>
                <td>
                  <span className={"status " + (st === "ok" ? "status-on-track" : st === "behind" ? "status-behind" : "status-pending")}>
                    {st === "ok" ? "On track" : st === "behind" ? `${duration(a!.m - need)} behind` : "To come"}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

// ---- Marathon shape ----------------------------------------------------------------

/** Planned runs as if done, so the shape can be projected forward. */
export function plannedRuns(plan: Plan, from: string, to: string, overrides?: Map<string, string>): Run[] {
  const out: Run[] = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
    const fw = forecastWeek(plan, m, [], overrides);
    // An undated last block (e.g. "Sharpen and taper") covers the weeks after the last dated one.
    if (!fw.week && !fw.block) {
      const lastEnd = plan.blocks.filter((b) => b.end).map((b) => b.end!).sort().pop();
      const undated = plan.blocks.find((b) => !b.start && b.kmMin);
      if (lastEnd && undated && m > lastEnd) fw.block = { ...undated, start: addDays(lastEnd, 1), end: to };
    }
    if (fw.week) {
      for (const d of fw.days) if (d.km && d.date > from && d.date <= to) out.push(fake(d.date, d.km));
    } else if (fw.block && fw.block.kmMin) {
      // Block weeks after the week table: the block's mid volume, with a long run from its description.
      const weekKm = (fw.block.kmMin + (fw.block.kmMax ?? fw.block.kmMin)) / 2;
      const lr = /long runs? of (\d+)(?:\s*[–-]\s*(\d+))?\s*km/i.exec(fw.block.key);
      const long = lr ? (+lr[1] + +(lr[2] ?? lr[1])) / 2 : Math.min(30, weekKm * 0.3);
      const rest = Math.max(0, weekKm - long);
      [0, 1, 2, 3, 5].forEach((i) => {
        const date = addDays(m, i);
        if (date > from && date <= to) out.push(fake(date, rest / 5));
      });
      const sun = addDays(m, 6);
      if (sun > from && sun <= to) out.push(fake(sun, long));
    }
  }
  return out;
}
const fake = (date: string, km: number): Run => ({
  id: `plan-${date}-${km}`,
  date,
  start_local: date,
  name: "Planned",
  sport: "Run",
  distance: km * 1000,
  moving_time: km * 300,
  elapsed_time: km * 300,
  elevation: 0,
  avg_hr: null,
  max_hr: null,
  workout_type: null,
  polyline: null,
  gear_id: null,
});

const SHAPE_DISTS = [
  { name: "Marathon", need: 1 },
  { name: "Half", need: 0.43 },
  { name: "10k", need: 0.17 },
  { name: "5k", need: 0.07 },
] as const;
type DistName = (typeof SHAPE_DISTS)[number]["name"];

interface ShapeSettings extends ShapeOptions {
  dist: DistName;
  /** What-if: scale the plan's weekly km. */
  planScale: number;
  /** What-if: add to every planned long run. */
  longExtra: number;
}
const SHAPE_SETTINGS: ShapeSettings = { ...SHAPE_DEFAULTS, dist: "Marathon", planScale: 1, longExtra: 0 };

/** Planned runs with the what-if changes applied (Sunday = the long run). */
function scaled(runs: Run[], scale: number, longExtra: number): Run[] {
  return runs.map((r) => {
    const sunday = parseKey(r.date).getDay() === 0;
    const kmv = (r.distance / 1000) * scale + (sunday && r.distance >= 14000 ? longExtra : 0);
    return { ...r, distance: kmv * 1000 };
  });
}

function Choice<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="shape-choice">
      <span className="label">{label}</span>
      <div className="segmented small-seg">
        {options.map((o) => (
          <button key={String(o.v)} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ShapeView({ f, plan, overrides }: { f: Fitness; plan: Plan; overrides?: Map<string, string> }) {
  const today = useToday();
  const [set, setSet] = useState<ShapeSettings>(SHAPE_SETTINGS);
  useEffect(() => {
    kvGet<ShapeSettings | null>("shape.settings", null).then((v) => v && setSet({ ...SHAPE_SETTINGS, ...v, planScale: 1, longExtra: 0 }));
  }, []);
  const update = (patch: Partial<ShapeSettings>) => {
    const next = { ...set, ...patch };
    setSet(next);
    kvSet("shape.settings", next);
  };
  const final = [...f.config.projection.milestones].sort((a, b) => b.date.localeCompare(a.date))[0];
  const need = SHAPE_DISTS.find((d) => d.name === set.dist)!.need;
  const opts: ShapeOptions = { weeklyWeeks: set.weeklyWeeks, longWeeks: set.longWeeks, longMin: set.longMin, weeklyShare: set.weeklyShare };
  const base = useMemo(() => (final ? plannedRuns(plan, today, final.date, overrides) : []), [plan, today, final?.date, overrides]);
  const data = useMemo(() => {
    if (!f.shape || !final) return null;
    const level = (d: string) => f.project(d) ?? f.current ?? 55;
    const pct = (x: number) => (x / need) * 100;
    const past: { x: string; y: number }[] = [];
    for (let w = addDays(mondayOf(today), -26 * 7); w <= mondayOf(today); w = addDays(w, 7)) past.push({ x: w, y: pct(marathonShape(f.runs, addDays(w, 6), level(w), opts).total) });
    const done = f.runs.filter((r) => r.date <= today);
    const planned = [...done, ...scaled(base, set.planScale, set.longExtra)];
    const ahead: { x: string; y: number }[] = [];
    for (let w = mondayOf(today); w <= final.date; w = addDays(w, 7)) ahead.push({ x: w, y: pct(marathonShape(planned, addDays(w, 6), level(w), opts).total) });
    const at = (date: string, runs = planned) => marathonShape(runs, date, level(date), opts);
    // How much more weekly volume would get each race to 100 % of what this distance needs.
    const scaleFor = (date: string) => {
      for (let k = 0.7; k <= 1.8; k += 0.05) if (at(date, [...done, ...scaled(base, k, set.longExtra)]).total >= need) return k;
      return null;
    };
    // Week by week: what you ran, then what the plan (with the what-ifs) has.
    const thisWeek = mondayOf(today);
    const weeks: { week: string; km: number; longest: number; planned: boolean }[] = [];
    const byWeek = new Map<string, { km: number; longest: number }>();
    for (const r of planned) {
      const w = mondayOf(r.date);
      const k = r.distance / 1000;
      const e = byWeek.get(w) ?? { km: 0, longest: 0 };
      e.km += k;
      e.longest = Math.max(e.longest, k);
      byWeek.set(w, e);
    }
    for (let w = past[0].x; w <= final.date; w = addDays(w, 7)) weeks.push({ week: w, ...(byWeek.get(w) ?? { km: 0, longest: 0 }), planned: w > thisWeek });
    return { past, ahead, at, scaleFor, weeks, thisWeek, now: marathonShape(f.runs, today, level(today), opts) };
  }, [f, base, today, final?.date, need, set.planScale, set.longExtra, set.weeklyWeeks, set.longWeeks, set.longMin, set.weeklyShare]);
  if (!f.shape || !data || !final) return <p className="muted">Not enough runs yet.</p>;
  const s = data.now;
  const pctOf = (x: number) => Math.round((x / need) * 100);
  return (
    <>
      <div className="shape-controls">
        <Choice label="Race" value={set.dist} options={SHAPE_DISTS.map((d) => ({ v: d.name, l: d.name }))} onChange={(v) => update({ dist: v })} />
        <Choice
          label="What if the plan's weekly km were"
          value={Math.round(set.planScale * 100)}
          options={[80, 90, 100, 110, 120, 130].map((v) => ({ v, l: `${v}%` }))}
          onChange={(v) => update({ planScale: v / 100 })}
        />
        <Choice label="Long runs" value={set.longExtra} options={[0, 2, 4, 6].map((v) => ({ v, l: v ? `+${v} km` : "as planned" }))} onChange={(v) => update({ longExtra: v })} />
      </div>
      <details className="shape-advanced">
        <summary className="small">How the shape is worked out</summary>
        <div className="shape-controls">
          <Choice label="Weekly km over" value={set.weeklyWeeks} options={[13, 26, 39].map((v) => ({ v, l: `${Math.round(v / 4.33)} months` }))} onChange={(v) => update({ weeklyWeeks: v })} />
          <Choice label="Long runs over" value={set.longWeeks} options={[6, 10, 14].map((v) => ({ v, l: `${v} weeks` }))} onChange={(v) => update({ longWeeks: v })} />
          <Choice label="Long runs count from" value={set.longMin} options={[10, 13, 16].map((v) => ({ v, l: `${v} km` }))} onChange={(v) => update({ longMin: v })} />
          <Choice
            label="Weekly km share"
            value={Math.round(set.weeklyShare * 100)}
            options={[50, 67, 80].map((v) => ({ v, l: `${v}%` }))}
            onChange={(v) => update({ weeklyShare: v === 67 ? 2 / 3 : v / 100 })}
          />
          <button className="btn" onClick={() => update({ ...SHAPE_DEFAULTS })}>
            Runalyze defaults
          </button>
        </div>
      </details>
      <p className="lead">
        {set.dist} shape: whether the training volume is there for {set.dist === "Marathon" ? "a marathon" : `a ${set.dist.toLowerCase()}`} at your fitness. 100% means fully ready
        {set.dist !== "Marathon" ? ` (a ${set.dist.toLowerCase()} needs ${Math.round(need * 100)}% of marathon shape)` : ""}.
      </p>
      <div className="tiles">
        <div className="tile">
          <div className="label">Now</div>
          <div className={"tile-value num " + (pctOf(s.total) >= 100 ? "tone-accent" : "")}>{pctOf(s.total)}%</div>
          <ShapeBar value={s.total / need} label={false} />
        </div>
        <div className="tile">
          <div className="label">Weekly km ({Math.round(set.weeklyShare * 100)}%)</div>
          <div className="tile-value num">{Math.round(s.weekly * 100)}%</div>
          <div className="muted small">
            {s.kmPerWeek.toFixed(0)} km/week (recent weeks count more) · marathon needs ~{s.targetKm.toFixed(0)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Long runs ({Math.round((1 - set.weeklyShare) * 100)}%)</div>
          <div className="tile-value num">{Math.round(s.long * 100)}%</div>
          <div className="muted small">
            Weekly longest run, from {set.longMin} km up to ~{s.targetLong.toFixed(0)} km
          </div>
        </div>
        {f.config.projection.milestones.map((m) => {
          // Judged at the start of the taper: shape always dips over the last two weeks, by design.
          const at = data.at(addDays(m.date, -14));
          const k = data.scaleFor(addDays(m.date, -14));
          const p = pctOf(at.total);
          return (
            <div className="tile" key={m.date}>
              <div className="label">{m.label.split(" · ")[1] ?? m.label} · 2 weeks out</div>
              <div className={"tile-value num " + (p >= 100 ? "tone-accent" : p >= 85 ? "tone-warn" : "tone-danger")}>{p}%</div>
              <div className="muted small">
                ~{at.kmPerWeek.toFixed(0)} km/week · needs {at.targetKm.toFixed(0)}
                {p < 100 && k ? ` · 100% needs the plan at ~${Math.round(k * 100)}% volume` : ""}
              </div>
            </div>
          );
        })}
      </div>
      <h3>Shape over time</h3>
      <LineChart
        from={data.past[0].x}
        to={final.date}
        height={220}
        today={today}
        digits={0}
        unit="%"
        yMin={0}
        markers={f.config.projection.milestones.map((m) => ({ x: m.date, label: m.label.split(" · ")[0] }))}
        series={[
          { name: "Your shape", kind: "line", className: "s-trend", points: data.past },
          { name: set.planScale !== 1 || set.longExtra ? "Plan with your changes" : "If you follow the plan", kind: "dashed", className: "s-proj", points: data.ahead },
          { name: "Ready", kind: "dashed", className: "s-goal", points: [{ x: data.past[0].x, y: 100 }, { x: final.date, y: 100 }] },
        ]}
      />
      <WeeklyBars weeks={data.weeks} thisWeek={data.thisWeek} need={data.at(final.date)} finalLabel={final.label.split(" · ")[0]} longMin={set.longMin} />
      <p className="muted small">
        Race tiles show your shape two weeks out, at the start of the taper: it always dips over the last two weeks as the volume comes down, and that's the fitness you take
        into the race. Targets grow with your fitness (VO2 max 50 → ~85 km/week and ~30 km long runs; 60 → ~105 and ~32). The projection uses the plan's weeks as estimated in the training
        calendar, including any days you've changed; the what-if buttons only change this page, not the plan.
      </p>
    </>
  );
}

const shortDate = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;

/** Weekly km and longest run per week under the shape chart: run so far, then planned (faint). */
function WeeklyBars({
  weeks,
  thisWeek,
  need,
  finalLabel,
  longMin,
}: {
  weeks: { week: string; km: number; longest: number; planned: boolean }[];
  thisWeek: string;
  need: { targetKm: number; targetLong: number };
  finalLabel: string;
  longMin: number;
}) {
  const label = (w: string) => (parseKey(w).getDate() <= 7 ? monthLabel(w) : "");
  const recent = weeks.filter((w) => !w.planned && w.week < thisWeek).slice(-4);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const peakPlan = weeks.filter((w) => w.planned);
  return (
    <div className="shape-weekly">
      <div className="shape-weekly-head">
        <h3>Weekly km</h3>
        <span className="muted small">
          Last 4 weeks {avg(recent.map((w) => w.km)).toFixed(0)} km/week · plan peaks at {Math.max(0, ...peakPlan.map((w) => w.km)).toFixed(0)} · solid = run, faint = planned
        </span>
      </div>
      <BarChart
        height={170}
        unit=" km"
        bars={weeks.map((w) => ({
          label: label(w.week),
          value: w.km,
          planned: w.planned,
          highlight: w.week === thisWeek,
          title: `Week of ${shortDate(w.week)}: ${w.km.toFixed(1)} km${w.planned ? " planned" : ""} · longest ${w.longest.toFixed(1)} km`,
        }))}
        refLine={{ value: need.targetKm, label: `~${need.targetKm.toFixed(0)} km/week for full shape by ${finalLabel}` }}
      />
      <div className="shape-weekly-head">
        <h3>Longest run each week</h3>
        <span className="muted small">
          Last 4 weeks' longest {Math.max(0, ...recent.map((w) => w.longest)).toFixed(0)} km · runs from {longMin} km count toward shape
        </span>
      </div>
      <BarChart
        height={150}
        unit=" km"
        bars={weeks.map((w) => ({
          label: label(w.week),
          value: w.longest,
          planned: w.planned,
          highlight: w.week === thisWeek,
          title: `Week of ${shortDate(w.week)}: longest ${w.longest.toFixed(1)} km${w.planned ? " (planned)" : ""}`,
        }))}
        refLine={{ value: need.targetLong, label: `~${need.targetLong.toFixed(0)} km long run for full shape by ${finalLabel}` }}
      />
    </div>
  );
}
