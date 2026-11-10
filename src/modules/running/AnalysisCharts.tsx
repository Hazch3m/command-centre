import { useMemo, useState, type ReactNode } from "react";
import { addDays, parseKey } from "../../core/time";
import { BarChart, LineChart, type LineSeries } from "../../shell/charts";
import type { HealthDay } from "../health/data";
import { vo2Series } from "./FitnessCard";
import { marathonShape, type Fitness } from "./fitness";
import { mondayOf } from "./plan";
import { monotony, type LoadPoint } from "./runalyze";
import { duration } from "./stats";
import type { Run } from "./strava";
import { predictTime } from "./vo2";

/** What a click on the analysis side panel (or the month total) charts. */
export type ChartKey = "km" | "vo2" | "shape" | "atl" | "ctl" | "tsb" | "acr" | "mono" | "strain" | "paces" | "rhr" | "sleep" | "hrv" | `prog:${number}`;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mmss = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const RANGES = [
  { days: 91, label: "3 months" },
  { days: 182, label: "6 months" },
  { days: 365, label: "1 year" },
];
const PROG: Record<number, string> = { 3000: "3 km", 5000: "5 km", 10000: "10 km", 21097.5: "Half marathon", 42195: "Marathon" };

export const chartTitle = (k: ChartKey): string =>
  k.startsWith("prog:")
    ? `Prognosis: ${PROG[Number(k.slice(5))] ?? k.slice(5)}`
    : ({ km: "Distance per month", vo2: "Effective VO2max", shape: "Marathon shape", atl: "Fatigue and fitness (ATL / CTL)", ctl: "Fatigue and fitness (ATL / CTL)", tsb: "Stress balance (TSB)", acr: "Workload ratio (A:C)", mono: "Monotony", strain: "Training strain", paces: "Pace of each run", rhr: "Resting heart rate", sleep: "Sleep", hrv: "HRV" } as Record<string, string>)[k];

interface Ctx {
  k: ChartKey;
  f: Fitness;
  runs: Run[];
  series: LoadPoint[];
  daily: Map<string, number>;
  health: HealthDay[];
  today: string;
  thresholdPace: number | null;
  easyPace: number | null;
  onMonth: (firstOfMonth: string) => void;
  onClose: () => void;
}

/** One chart for the thing you clicked, over the last 3, 6 or 12 months. */
export function AnalysisChart(c: Ctx) {
  const [days, setDays] = useState(c.k === "km" ? 365 : 182);
  const from = addDays(c.today, -days);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const body = useMemo(() => draw(c, from), [c.k, from, c.f, c.runs, c.series, c.health, c.thresholdPace]);
  const v = (body.vals ?? []).filter((p): p is { x: string; y: number } => p.y != null && isFinite(p.y));
  const fmt = body.fmt ?? ((x: number) => (Math.abs(x) >= 100 ? Math.round(x).toString() : x.toFixed(1)));
  const now = v.at(-1);
  const first = v[0];
  const hi = v.length ? v.reduce((a, b) => (b.y > a.y ? b : a)) : null;
  const lo = v.length ? v.reduce((a, b) => (b.y < a.y ? b : a)) : null;
  const ch = now && first ? now.y - first.y : null;
  const good = ch == null || !body.better || Math.abs(ch) < 1e-9 ? null : (ch > 0) === (body.better === "up");
  const when = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
  return (
    <section className="ana-chart">
      <div className="ana-chart-head">
        <b>{chartTitle(c.k)}</b>
        {body.note && <span className="muted small">{body.note}</span>}
        <span className="segmented small-seg">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </span>
        <button type="button" className="ana-chart-x" onClick={c.onClose} aria-label="Close chart">
          ×
        </button>
      </div>
      <div className={"ana-chart-body" + (now ? " with-stats" : "")}>
        <div className="ana-chart-plot">{body.el}</div>
        {now && (
          <dl className="ana-chart-stats">
            <div>
              <dt>Now</dt>
              <dd className="num">{fmt(now.y)}</dd>
            </div>
            {ch != null && (
              <div>
                <dt>Change</dt>
                <dd className={"num " + (good == null ? "" : good ? "tone-accent" : "tone-danger")}>
                  {ch > 0 ? "+" : ch < 0 ? "−" : ""}
                  {fmt(Math.abs(ch))}
                </dd>
              </div>
            )}
            {hi && (
              <div>
                <dt>High</dt>
                <dd className="num">
                  {fmt(hi.y)} <small>{when(hi.x)}</small>
                </dd>
              </div>
            )}
            {lo && (
              <div>
                <dt>Low</dt>
                <dd className="num">
                  {fmt(lo.y)} <small>{when(lo.x)}</small>
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

function line(name: string, cls: string, points: LineSeries["points"], kind: LineSeries["kind"] = "line"): LineSeries {
  return { name, kind, className: cls, points };
}
const flat = (name: string, from: string, to: string, y: number): LineSeries => line(name, "s-proj", [{ x: from, y }, { x: to, y }], "dashed");

interface Drawn {
  el: ReactNode;
  note?: string;
  /** The main line's values, for the numbers beside the chart. */
  vals?: { x: string; y: number | null }[];
  fmt?: (v: number) => string;
  /** Which way is better (for the colour of the change). */
  better?: "up" | "down";
}

function draw(c: Ctx, from: string): Drawn {
  const { k, f, today } = c;
  const lc = (series: LineSeries[], extra: Partial<Parameters<typeof LineChart>[0]> = {}) => <LineChart series={series} from={from} to={today} height={190} today={today} {...extra} />;
  if (k === "km") {
    const months: { from: string; km: number; n: number }[] = [];
    const d = parseKey(today);
    const count = Math.max(3, Math.round((Date.parse(today) - Date.parse(from)) / (30.4 * 86400000)));
    for (let i = count - 1; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
      const rs = c.runs.filter((r) => r.date.startsWith(key));
      months.push({ from: key + "-01", km: rs.reduce((a, r) => a + r.distance, 0) / 1000, n: rs.length });
    }
    return {
      vals: months.slice(0, -1).map((m) => ({ x: m.from, y: m.km })),
      fmt: (v) => `${Math.round(v)} km`,
      better: "up",
      note: "click a month to see its runs · change: last full month against the first",
      el: (
        <BarChart
          height={190}
          unit=" km"
          bars={months.map((m, i) => ({ label: MON[parseKey(m.from).getMonth()], value: m.km, highlight: i === months.length - 1, title: `${MON[parseKey(m.from).getMonth()]} ${m.from.slice(0, 4)}: ${m.km.toFixed(1)} km, ${m.n} runs` }))}
          onBar={(i) => c.onMonth(months[i].from)}
        />
      ),
    };
  }
  if (k === "vo2") return { vals: f.weekly.filter((w) => w.week >= from).map((w) => ({ x: w.week, y: w.smooth == null ? null : w.smooth + f.shift })), better: "up", note: "dots: runs · line: trend · diamonds: races", el: lc(vo2Series(f, from, today).filter((s) => s.name !== "Plan" || s.points.length)) };
  if (k === "shape") {
    const vd = f.predictionBasis?.vdot ?? f.current;
    if (!vd) return { el: <p className="ana-note">Needs runs with heart rate, or a race result.</p> };
    const pts: LineSeries["points"] = [];
    for (let w = mondayOf(from); w <= today; w = addDays(w, 7)) pts.push({ x: w, y: Math.round(marathonShape(c.runs, addDays(w, 6) > today ? today : addDays(w, 6), vd).total * 100) });
    return { vals: pts, fmt: (v) => `${Math.round(v)} %`, better: "up", note: "weekly km and long runs over the 26 weeks before, against what your level needs", el: lc([line("Marathon shape", "s-trend", pts)], { unit: " %", digits: 0 }) };
  }
  const ser = c.series.filter((p) => p.date >= from);
  if (k === "atl" || k === "ctl")
    return {
      vals: ser.map((p) => ({ x: p.date, y: Math.round(k === "atl" ? p.atl : p.ctl) })),
      fmt: (v) => `${Math.round(v)}`,
      better: k === "ctl" ? "up" : undefined,
      note: `fatigue: 7-day load · fitness: 42-day load · numbers: ${k === "atl" ? "fatigue" : "fitness"}`,
      el: lc([line("Fitness (CTL)", "s-ctl", ser.map((p) => ({ x: p.date, y: Math.round(p.ctl) }))), line("Fatigue (ATL)", "s-atl", ser.map((p) => ({ x: p.date, y: Math.round(p.atl) })))], { digits: 0 }),
    };
  if (k === "tsb") return { vals: ser.map((p) => ({ x: p.date, y: Math.round(p.tsb) })), fmt: (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`, note: "fitness minus fatigue: above 0 fresh, well below tired", el: lc([line("Stress balance", "s-trend", ser.map((p) => ({ x: p.date, y: Math.round(p.tsb) }))), flat("0", from, today, 0)], { digits: 0 }) };
  if (k === "acr")
    return {
      vals: ser.map((p) => ({ x: p.date, y: p.ctl ? p.atl / p.ctl : null })),
      fmt: (v) => v.toFixed(2),
      note: "0.8–1.3 is the usual safe band; above 1.5 is a jump",
      el: lc([line("A:C", "s-trend", ser.map((p) => ({ x: p.date, y: p.ctl ? Math.round((p.atl / p.ctl) * 100) / 100 : null }))), flat("0.8", from, today, 0.8), flat("1.3", from, today, 1.3)], { digits: 2 }),
    };
  if (k === "mono" || k === "strain") {
    const pts: LineSeries["points"] = [];
    for (let d = addDays(mondayOf(from), 6); d <= today; d = addDays(d, 7)) {
      const m = monotony(c.daily, d);
      pts.push({ x: d, y: k === "mono" ? (m.monotony != null ? Math.round(m.monotony * 100) / 100 : null) : Math.round(m.strain) });
    }
    return {
      vals: pts,
      fmt: (v) => (k === "mono" ? v.toFixed(2) : `${Math.round(v)}`),
      note: k === "mono" ? "each week: how alike the days were (above 2 = too samey)" : "each week: load × monotony",
      el: lc([line(k === "mono" ? "Monotony" : "Strain", "s-trend", pts)], { digits: k === "mono" ? 2 : 0 }),
    };
  }
  if (k.startsWith("prog:")) {
    const m = Number(k.slice(5));
    const pts = f.weekly.filter((w) => w.week >= from && w.smooth != null).map((w) => ({ x: addDays(w.week, 3), y: predictTime(m, w.smooth!) }));
    const races = f.races.filter((r) => r.date >= from).map((r) => ({ x: r.date, y: predictTime(m, r.vdot), label: r.name }));
    return { vals: pts, fmt: (v) => duration(v), better: "down", note: "from your VO2max trend, as if fully trained for the distance · diamonds: races", el: lc([line("Prognosis", "s-trend", pts), line("Race", "s-race", races, "diamonds")], { format: (v) => duration(v) }) };
  }
  if (k === "paces") {
    const pts = c.runs.filter((r) => r.date >= from && r.distance > 1500).map((r) => ({ x: r.date, y: r.moving_time / (r.distance / 1000), label: r.name }));
    const s = [line("Run", "s-est", pts, "dots")];
    if (c.thresholdPace) s.push(flat("Threshold", from, today, c.thresholdPace));
    if (c.easyPace) s.push(flat("Easy", from, today, c.easyPace));
    return { vals: pts, fmt: mmss, better: "down", note: "average pace of each run · dashed: your threshold and easy paces", el: lc(s, { format: mmss }) };
  }
  const h = c.health.filter((d) => d.date >= from);
  if (k === "rhr") return { vals: h.map((d) => ({ x: d.date, y: d.rhr })), fmt: (v) => `${Math.round(v)} bpm`, better: "down", el: lc([line("Resting HR", "s-trend", h.map((d) => ({ x: d.date, y: d.rhr })))], { unit: " bpm", digits: 0 }) };
  if (k === "sleep") return { vals: h.map((d) => ({ x: d.date, y: d.sleep_secs ? d.sleep_secs / 3600 : null })), fmt: (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")} h`, better: "up", el: lc([line("Sleep", "s-trend", h.map((d) => ({ x: d.date, y: d.sleep_secs ? Math.round((d.sleep_secs / 3600) * 10) / 10 : null })))], { unit: " h", digits: 1 }) };
  return {
    vals: h.map((d) => ({ x: d.date, y: d.hrv_week ?? d.hrv })),
    fmt: (v) => `${Math.round(v)} ms`,
    better: "up",
    note: "nightly HRV and its 7-day average",
    el: lc([line("HRV", "s-est", h.map((d) => ({ x: d.date, y: d.hrv })), "dots"), line("7-day", "s-trend", h.map((d) => ({ x: d.date, y: d.hrv_week })))], { unit: " ms", digits: 0 }),
  };
}
