import { useMemo } from "react";
import { addDays, parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { mondayOf, weekFor, type Plan } from "./plan";
import { recentVsPrevious, weeklyTotals, type PeriodStats } from "./stats";
import type { Run } from "./strava";
import { openWeek } from "./RunView";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const paceStr = (s: number | null) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

type Row = { label: string; get: (p: PeriodStats) => number | null; show: (v: number | null) => string; unit: string; /** Is a bigger number better? */ up: boolean | null };
const ROWS: Row[] = [
  { label: "Distance", get: (p) => p.kmPerWeek, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "km/week", up: true },
  { label: "Runs", get: (p) => p.runsPerWeek, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "per week", up: true },
  { label: "Time", get: (p) => p.hoursPerWeek, show: (v) => (v == null ? "–" : `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`), unit: "h/week", up: true },
  { label: "Long run", get: (p) => p.longRun, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "km, weekly average", up: true },
  { label: "Average pace", get: (p) => p.pace, show: paceStr, unit: "/km", up: false },
  { label: "Average heart rate", get: (p) => p.hr, show: (v) => (v == null ? "–" : String(Math.round(v))), unit: "bpm", up: null },
  { label: "Climb", get: (p) => p.climbPerWeek, show: (v) => (v == null ? "–" : String(Math.round(v))), unit: "m/week", up: null },
];

/** Last 4 weeks against the 12 before them, per week, with a 16-week chart. */
export function RecentBlock({ runs, plan }: { runs: Run[]; plan: Plan }) {
  const today = useToday();
  const cmp = useMemo(() => recentVsPrevious(runs, today), [runs, today]);
  const bars = useMemo(() => {
    const mon = mondayOf(today);
    return weeklyTotals(runs, addDays(mon, -15 * 7), mon).map((w) => {
      const pw = weekFor(plan, w.week);
      return {
        label: String(parseKey(w.week).getDate()),
        value: w.km,
        target: pw?.kmMin ?? null,
        targetMax: pw?.kmMax ?? null,
        highlight: w.week >= mondayOf(cmp.recentFrom),
        title: `Week of ${fmt(w.week)}: ${w.km.toFixed(1)} km, ${w.runs} runs`,
      };
    });
  }, [runs, plan, today, cmp.recentFrom]);
  const weeks = useMemo(() => Array.from({ length: 16 }, (_, i) => addDays(mondayOf(today), (i - 15) * 7)), [today]);
  return (
    <section className="recent-block">
      <div className="recent-head">
        <h3>Last 4 weeks vs the 12 before</h3>
        <span className="muted small">
          {fmt(cmp.recentFrom)} – today, against {fmt(cmp.prevFrom)} – {fmt(cmp.prevTo)} (per-week averages)
        </span>
      </div>
      <div className="recent-body">
      <div className="recent-grid">
        {ROWS.map((r) => {
          const a = r.get(cmp.recent);
          const b = r.get(cmp.previous);
          const diff = a != null && b != null ? a - b : null;
          const pct = diff != null && b ? (diff / b) * 100 : null;
          const good = diff == null || r.up == null || Math.abs(pct ?? 0) < 3 ? null : (diff > 0) === r.up;
          return (
            <div key={r.label} className="recent-cell">
              <div className="label">{r.label}</div>
              <div className="recent-value">
                <span className="num">{r.show(a)}</span> <span className="muted small">{r.unit}</span>
              </div>
              <div className="small">
                <span className={good == null ? "muted" : good ? "tone-accent" : "tone-danger"}>
                  {diff == null
                    ? "–"
                    : r.label === "Average pace"
                      ? `${Math.abs(Math.round(diff))} s/km ${diff <= 0 ? "faster" : "slower"}`
                      : `${diff >= 0 ? "▲" : "▼"} ${pct != null ? `${Math.abs(Math.round(pct))}%` : r.show(Math.abs(diff))}`}
                </span>
                <span className="muted"> vs {r.show(b)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="recent-chart">
        <BarChart
          bars={bars}
          height={220}
          unit=" km"
          onBar={(i) => openWeek(weeks[i])}
          refLine={{ value: cmp.previous.kmPerWeek, label: `Previous 12-week average: ${cmp.previous.kmPerWeek.toFixed(0)} km` }}
        />
        <div className="muted small">Last 4 weeks highlighted · dashed: the 12-week average before · marks: the plan's target · click a week to see its runs</div>
      </div>
      </div>
    </section>
  );
}
