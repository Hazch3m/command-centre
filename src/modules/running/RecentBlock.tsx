import { useMemo, useState } from "react";
import { addDays, parseKey, useToday } from "../../core/time";
import { BarChart, LineChart } from "../../shell/charts";
import { mondayOf, weekFor, type Plan } from "./plan";
import { recentVsPrevious, weeklyTotals, type PeriodStats } from "./stats";
import type { Run } from "./strava";
import { openWeek } from "./RunView";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const paceStr = (s: number | null) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);

type Key = "km" | "runs" | "hours" | "long" | "pace" | "hr" | "climb";
type Row = { key: Key; label: string; get: (p: PeriodStats) => number | null; show: (v: number | null) => string; unit: string; /** Is a bigger number better? */ up: boolean | null };
const ROWS: Row[] = [
  { key: "km", label: "Distance", get: (p) => p.kmPerWeek, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "km/week", up: true },
  { key: "runs", label: "Runs", get: (p) => p.runsPerWeek, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "per week", up: true },
  { key: "hours", label: "Time", get: (p) => p.hoursPerWeek, show: (v) => (v == null ? "–" : `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`), unit: "h/week", up: true },
  { key: "long", label: "Long run", get: (p) => p.longRun, show: (v) => (v == null ? "–" : v.toFixed(1)), unit: "km, weekly average", up: true },
  { key: "pace", label: "Average pace", get: (p) => p.pace, show: paceStr, unit: "/km", up: false },
  { key: "hr", label: "Average heart rate", get: (p) => p.hr, show: (v) => (v == null ? "–" : String(Math.round(v))), unit: "bpm", up: null },
  { key: "climb", label: "Climb", get: (p) => p.climbPerWeek, show: (v) => (v == null ? "–" : String(Math.round(v))), unit: "m/week", up: null },
];

/** One number per week for the chosen measure. */
function weekValue(rs: Run[], key: Key): number | null {
  const dist = rs.reduce((a, r) => a + r.distance, 0);
  const time = rs.reduce((a, r) => a + r.moving_time, 0);
  if (key === "km") return dist / 1000;
  if (key === "runs") return rs.length;
  if (key === "hours") return time / 3600;
  if (key === "long") return rs.reduce((a, r) => Math.max(a, r.distance / 1000), 0);
  if (key === "climb") return rs.reduce((a, r) => a + (r.elevation ?? 0), 0);
  if (!rs.length) return null;
  if (key === "pace") return dist ? time / (dist / 1000) : null;
  const hr = rs.filter((r) => r.avg_hr);
  const hd = hr.reduce((a, r) => a + r.distance, 0);
  return hd ? hr.reduce((a, r) => a + r.avg_hr! * r.distance, 0) / hd : null;
}
const RANGES = [
  { weeks: 16, label: "16 weeks" },
  { weeks: 26, label: "6 months" },
  { weeks: 52, label: "1 year" },
  { weeks: 104, label: "2 years" },
];

/**
 * Last 4 weeks against the 12 before them, per week. Click a measure to chart
 * it week by week; choose how far back the chart goes.
 */
export function RecentBlock({ runs, plan }: { runs: Run[]; plan: Plan }) {
  const today = useToday();
  const [key, setKey] = useState<Key>("km");
  const [span, setSpan] = useState(16);
  const row = ROWS.find((r) => r.key === key)!;
  const cmp = useMemo(() => recentVsPrevious(runs, today), [runs, today]);
  const weeks = useMemo(() => Array.from({ length: span }, (_, i) => addDays(mondayOf(today), (i - span + 1) * 7)), [today, span]);
  const bars = useMemo(() => {
    const totals = new Map(weeklyTotals(runs, weeks[0], weeks[weeks.length - 1]).map((w) => [w.week, w]));
    return weeks.map((w, i) => {
      const rs = runs.filter((r) => r.date >= w && r.date <= addDays(w, 6));
      const v = weekValue(rs, key);
      const pw = key === "km" ? weekFor(plan, w) : null;
      const first = parseKey(w).getDate() <= 7;
      return {
        label: span <= 16 ? String(parseKey(w).getDate()) : first || i === 0 ? MON[parseKey(w).getMonth()] : "",
        value: v ?? 0,
        target: pw?.kmMin ?? null,
        targetMax: pw?.kmMax ?? null,
        highlight: w >= mondayOf(cmp.recentFrom),
        title: `Week of ${fmt(w)}: ${row.show(v)} ${row.unit}${key !== "runs" && key !== "km" ? "" : ` · ${totals.get(w)?.runs ?? 0} runs, ${(totals.get(w)?.km ?? 0).toFixed(1)} km`}`,
      };
    });
  }, [runs, plan, weeks, key, span, cmp.recentFrom, row]);
  const prevAvg = row.get(cmp.previous);
  return (
    <section className="recent-block">
      <div className="recent-head">
        <h3>Last 4 weeks vs the 12 before</h3>
        <span className="muted small">
          {fmt(cmp.recentFrom)} – today, against {fmt(cmp.prevFrom)} – {fmt(cmp.prevTo)} (per-week averages) · click one to chart it
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
            <button key={r.label} className={"recent-cell" + (r.key === key ? " sel" : "")} onClick={() => setKey(r.key)} aria-pressed={r.key === key}>
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
            </button>
          );
        })}
      </div>
      <div className="recent-chart">
        <div className="recent-chart-head">
          <b>{row.label}</b> <span className="muted small">{row.unit.replace(/^per week$/, "runs per week")}, week by week</span>
          <span className="segmented small-seg">
            {RANGES.map((r) => (
              <button key={r.weeks} className={span === r.weeks ? "on" : ""} onClick={() => setSpan(r.weeks)}>
                {r.label}
              </button>
            ))}
          </span>
        </div>
        {key === "pace" ? (
          <LineChart
            from={weeks[0]}
            to={addDays(weeks[weeks.length - 1], 6)}
            height={220}
            today={today}
            format={(v) => paceStr(v)}
            series={[
              { name: "Average pace", kind: "line", className: "s-trend", points: weeks.map((w) => ({ x: addDays(w, 3), y: weekValue(runs.filter((r) => r.date >= w && r.date <= addDays(w, 6)), "pace") })) },
              ...(prevAvg != null ? [{ name: "Previous 12-week average", kind: "dashed" as const, className: "s-proj", points: [{ x: weeks[0], y: prevAvg }, { x: addDays(weeks[weeks.length - 1], 6), y: prevAvg }] }] : []),
            ]}
          />
        ) : (
          <BarChart
            bars={bars}
            height={220}
            unit={key === "km" ? " km" : ""}
            digits={key === "hours" ? 1 : 0}
            showValues={span <= 26}
            onBar={(i) => openWeek(weeks[i])}
            refLine={prevAvg != null ? { value: prevAvg, label: `Previous 12-week average: ${row.show(prevAvg)}` } : null}
          />
        )}
        <div className="muted small">Last 4 weeks highlighted · dashed: the 12-week average before{key === "km" ? " · marks: the plan's target" : ""} · click a week to see its runs</div>
      </div>
      </div>
    </section>
  );
}
