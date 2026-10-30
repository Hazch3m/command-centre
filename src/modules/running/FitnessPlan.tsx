import { useMemo } from "react";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { LineChart } from "../../shell/charts";
import { loadHealth, type HealthDay } from "../health/data";
import { marathonShape, showVo2, type Fitness } from "./fitness";
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

  if (!model || !final) return <p className="muted">Needs a marathon prediction first (connect Garmin, or race at two distances).</p>;
  const { required, path, actual, startDate, now } = model;
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
  const actualAt = (date: string) => actual.filter((a) => a.date <= date && a.date > addDays(date, -10)).pop() ?? null;
  const nowM = now.Marathon!;
  const reqNow = path(today);
  const onTrack = nowM <= reqNow + 5;

  return (
    <>
      <p className="lead">
        To run <b>{hmm(final.seconds)}</b> at {final.label.split(" · ")[1] ?? "the goal race"} ({fmtDate(final.date)}), your marathon prediction needs to come down steadily from{" "}
        {duration(model.base.Marathon)} ({fmtDate(startDate)}). Today it should be <b>{duration(reqNow)}</b>; it's <b className={onTrack ? "tone-accent" : "tone-danger"}>{duration(nowM)}</b>{" "}
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

      <h3>Marathon prediction against the path</h3>
      <LineChart
        from={from}
        to={final.date}
        height={220}
        today={today}
        format={hmm}
        markers={goals.map((g) => ({ x: g.date, label: g.label.split(" · ")[0] }))}
        series={[
          { name: "Needed", kind: "dashed", className: "s-proj", points: checkpoints.map((d) => ({ x: d, y: path(d) })).concat([{ x: startDate, y: path(startDate) }]).sort((a, b) => a.x.localeCompare(b.x)) },
          { name: f.predictions.some((p) => p.source === "garmin") ? "Garmin prediction" : "Prediction", kind: "line", className: "s-trend", points: actual.map((a) => ({ x: a.date, y: a.m })) },
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
            <th className="num-col">Your marathon</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {checkpoints.map((d) => {
            const a = d <= today ? actualAt(d) : d === checkpoints.find((c) => c >= today) ? { m: nowM } : null;
            const need = path(d);
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
function plannedRuns(plan: Plan, from: string, to: string, overrides?: Map<string, string>): Run[] {
  const out: Run[] = [];
  for (let m = mondayOf(from); m <= to; m = addDays(m, 7)) {
    const fw = forecastWeek(plan, m, [], overrides);
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

export function ShapeView({ f, plan, overrides }: { f: Fitness; plan: Plan; overrides?: Map<string, string> }) {
  const today = useToday();
  const final = [...f.config.projection.milestones].sort((a, b) => b.date.localeCompare(a.date))[0];
  const data = useMemo(() => {
    if (!f.shape || !final) return null;
    const level = (d: string) => f.project(d) ?? f.current ?? 55;
    const past: { x: string; y: number }[] = [];
    for (let w = addDays(mondayOf(today), -26 * 7); w <= mondayOf(today); w = addDays(w, 7)) past.push({ x: w, y: marathonShape(f.runs, addDays(w, 6), level(w)).total * 100 });
    const planned = [...f.runs.filter((r) => r.date <= today), ...plannedRuns(plan, today, final.date, overrides)];
    const ahead: { x: string; y: number }[] = [];
    for (let w = mondayOf(today); w <= final.date; w = addDays(w, 7)) ahead.push({ x: w, y: marathonShape(planned, addDays(w, 6), level(w)).total * 100 });
    const at = (date: string) => marathonShape(planned, date, level(date));
    return { past, ahead, at };
  }, [f, plan, overrides, today, final?.date]);
  if (!f.shape || !data || !final) return <p className="muted">Not enough runs yet.</p>;
  const s = f.shape;
  return (
    <>
      <p className="lead">
        Marathon shape (as in Runalyze) says whether the training volume is there for the marathon your fitness could run. A marathon needs <b>100%</b>, a half 43%, a 10k 17%.
      </p>
      <div className="tiles">
        <div className="tile">
          <div className="label">Shape now</div>
          <div className="tile-value num">{Math.round(s.total * 100)}%</div>
          <ShapeBar value={s.total} label={false} />
        </div>
        <div className="tile">
          <div className="label">Weekly km (counts 2/3)</div>
          <div className="tile-value num">{Math.round(s.weekly * 100)}%</div>
          <div className="muted small">
            {s.kmPerWeek.toFixed(0)} km/week over 6 months, recent weeks counting more · needs ~{s.targetKm.toFixed(0)}
          </div>
        </div>
        <div className="tile">
          <div className="label">Long runs (counts 1/3)</div>
          <div className="tile-value num">{Math.round(s.long * 100)}%</div>
          <div className="muted small">Weekly longest run over 10 weeks, from 13 km up to ~{s.targetLong.toFixed(0)} km</div>
        </div>
        {f.config.projection.milestones.map((m) => {
          const at = data.at(m.date);
          return (
            <div className="tile" key={m.date}>
              <div className="label">{m.label.split(" · ")[1] ?? m.label} if you follow the plan</div>
              <div className={"tile-value num " + (at.total >= 1 ? "tone-accent" : at.total >= 0.85 ? "tone-warn" : "tone-danger")}>{Math.round(at.total * 100)}%</div>
              <div className="muted small">
                ~{at.kmPerWeek.toFixed(0)} km/week · needs {at.targetKm.toFixed(0)}
              </div>
            </div>
          );
        })}
      </div>
      <h3>Shape over time</h3>
      <LineChart
        from={data.past[0].x}
        to={final.date}
        height={200}
        today={today}
        digits={0}
        unit="%"
        yMin={0}
        markers={f.config.projection.milestones.map((m) => ({ x: m.date, label: m.label.split(" · ")[0] }))}
        series={[
          { name: "Your shape", kind: "line", className: "s-trend", points: data.past },
          { name: "If you follow the plan", kind: "dashed", className: "s-proj", points: data.ahead },
          { name: "Marathon needs", kind: "dashed", className: "s-acute", points: [{ x: data.past[0].x, y: 100 }, { x: final.date, y: 100 }] },
        ]}
      />
      <p className="muted small">
        The targets grow as your fitness does (VO2 max 50 → ~85 km/week and ~30 km long runs; 60 → ~105 and ~32). The dashed line assumes the plan's weeks as estimated in
        the training calendar, including any changes you've made.
      </p>
    </>
  );
}
