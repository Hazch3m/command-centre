import { useMemo, useState } from "react";
import { useBox } from "../../shell/charts";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { forecastWeek, type ForecastDay } from "./forecast";
import { checkDays, checkUnplanned, fmtPace, fmtTarget, fmtVal, verdictLabel, type PaceCheck } from "./pace";
import { mondayOf, type Plan } from "./plan";
import { loadDetails, loadOverrides, type Run } from "./strava";
import { openRun } from "./RunView";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;

/** Pace checks for the runs in the last `weeks` weeks (this week included), newest first. */
export function usePaceChecks(plan: Plan | undefined, runs: Run[] | undefined, weeks = 6) {
  const today = useToday();
  const version = useDataVersion("running");
  const from = addDays(mondayOf(today), -7 * (weeks - 1));
  const { data } = useQuery(() => Promise.all([loadDetails(from), loadOverrides()]), [version, from]);
  return useMemo(() => {
    if (!plan || !runs || !data) return null;
    const [details, overrides] = data;
    const rows: { day: ForecastDay; check: PaceCheck }[] = [];
    for (let m = from; m <= mondayOf(today); m = addDays(m, 7)) {
      const fw = forecastWeek(plan, m, runs, overrides);
      const checks = checkDays(fw.days, details);
      for (const d of fw.days) for (const r of d.runs) if (checks.get(r.id)) rows.push({ day: d, check: checks.get(r.id)! });
      // Weeks outside the plan: quick runs judged against the nearest training pace.
      if (!fw.week)
        for (const d of fw.days)
          for (const r of d.runs) {
            const c = checkUnplanned(r, details.get(r.id) ?? null, plan.paces);
            if (c) rows.push({ day: { ...d, text: `${r.name} (before the plan: judged as ${c.autoZone})`, kind: "key" }, check: c });
          }
    }
    rows.sort((a, b) => b.check.date.localeCompare(a.check.date));
    // Runs outside the plan show on the chart but don't count toward the scores.
    const avg = (all: PaceCheck[]) => {
      const xs = all.filter((c) => !c.autoZone);
      return xs.length ? Math.round(xs.reduce((s, c) => s + c.score, 0) / xs.length) : null;
    };
    return {
      rows,
      last14: avg(rows.filter((r) => r.check.date > addDays(today, -14)).map((r) => r.check)),
      onPointShare: rows.length ? rows.filter((r) => r.check.verdict === "on-point").length / rows.length : null,
      // Weeks before the plan get a score from the runs judged against the nearest training pace (marked "est.").
      byWeek: [...new Set(rows.map((r) => mondayOf(r.check.date)))].map((w) => {
        const inWeek = rows.filter((r) => mondayOf(r.check.date) === w).map((r) => r.check);
        const planned = avg(inWeek);
        const all = inWeek.length ? Math.round(inWeek.reduce((a, c) => a + c.score, 0) / inWeek.length) : null;
        return { week: w, score: planned ?? all, estimate: planned == null && all != null };
      }),
      details,
      overrides,
    };
  }, [plan, runs, data, from, today]);
}

export const verdictClass = (c: PaceCheck) => (c.verdict === "on-point" ? "tone-accent" : c.verdict.startsWith("slightly") ? "tone-warn" : "tone-danger");

export function PaceBadge({ c }: { c: PaceCheck }) {
  return (
    <span
      className={"pace-badge " + verdictClass(c)}
      title={`${c.measured}: ${fmtVal(c, c.actual)} against ${fmtTarget(c)}${c.inRange != null ? ` · ${Math.round(c.inRange * 100)}% of the work in range` : ""}`}
    >
      {verdictLabel(c)}
      {c.off !== 0 && c.verdict !== "on-point" ? (c.unit === "bpm" ? ` ${c.off < 0 ? "+" : "−"}${Math.abs(Math.round(c.off))} bpm` : ` ${c.off > 0 ? "+" : "−"}${Math.abs(Math.round(c.off))}s`) : ""}
    </span>
  );
}

/** The "Pace on point" tab of the Training page. */
export function PaceOnPointTab({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const p = usePaceChecks(plan, runs, 12);
  if (!p) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="lead">
        How close each run was to the pace the plan asked for.{" "}
        {p.last14 != null ? (
          <>
            Last 14 days: <b className="num">{p.last14}%</b> on point.
          </>
        ) : (
          "No planned runs with a pace target yet."
        )}
      </p>
      <p className="muted small">
        Easy and long runs are judged on the whole run, and slower than the easy range still counts as on point. Sessions are judged on the work only: the watch laps that look
        like reps (press lap or use a structured workout), otherwise the fastest kilometres adding up to the work. Within 3 s/km of the range counts as on point. Reps shorter
        than 1 km need laps.
      </p>
      <IntervalChart rows={p.rows} />
      {p.byWeek.length > 0 && (
        <div className="pace-weeks">
          {p.byWeek.map((w) => (
            <div key={w.week} className="pace-week">
              <span className="label">Week of {fmt(w.week)}</span>
              <span className="num">
                {w.score ?? "–"}%{w.estimate ? <span className="muted small"> est.</span> : null}
              </span>
              <span className="pace-bar">
                <span style={{ width: `${w.score ?? 0}%` }} />
              </span>
            </div>
          ))}
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Plan</th>
            <th className="num-col">Target</th>
            <th className="num-col">You ran</th>
            <th>Measured on</th>
            <th>Verdict</th>
            <th className="num-col">Score</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map(({ day, check: c }) => (
            <tr key={c.runId}>
              <td className="nowrap">
                {day.dow} {fmt(c.date)}
              </td>
              <td>{day.text}</td>
              <td className="num-col nowrap">{fmtTarget(c)}</td>
              <td className="num-col">{fmtVal(c, c.actual)}</td>
              <td className="muted">
                {c.measured}
                {c.inRange != null ? ` · ${Math.round(c.inRange * 100)}% in range` : ""}
              </td>
              <td>
                <PaceBadge c={c} />
              </td>
              <td className="num-col">{c.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!p.rows.length && <p className="muted">Runs on planned days will appear here once the plan starts.</p>}
    </>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
type Band = "fast" | "on" | "slow";
const bandOf = (pace: number, [lo, hi]: [number, number]): Band => (pace < lo - 5 ? "fast" : pace > hi + 5 ? "slow" : "on");
const BAND_LABEL: Record<Band, string> = { fast: "faster than target", on: "on target", slow: "slower than target" };
const offText = (pace: number, [lo, hi]: [number, number], bpm = false) =>
  pace < lo ? `${Math.round(lo - pace)} ${bpm ? "bpm high" : "s fast"}` : pace > hi ? `${Math.round(pace - hi)} ${bpm ? "bpm low" : "s slow"}` : "in range";

/**
 * Key sessions over the last weeks, Runna-style: for each one the fastest and
 * slowest rep (or km) against the target range. Faster is up.
 */
export function IntervalChart({ rows }: { rows: { day: ForecastDay; check: PaceCheck }[] }) {
  const [ref, box] = useBox(false);
  const [hover, setHover] = useState<number | null>(null);
  const sessions = rows.filter((r) => r.check.session && r.check.fastest != null).sort((a, b) => a.check.date.localeCompare(b.check.date));
  // Heart-rate mode: values are stored as negative bpm, so harder is still up. One unit per chart.
  const bpm = sessions.some((r) => r.check.unit === "bpm");
  const items = sessions.filter((r) => (r.check.unit === "bpm") === bpm);
  if (!items.length)
    return (
      <div className="interval-chart">
        <h3>Key sessions against their target</h3>
        <p className="muted small">No sessions with quick laps or kilometres in the last 12 weeks yet. Your plan's first is the threshold session on Tue 17 Nov.</p>
      </div>
    );
  const W = box.w || 800;
  const H = 300;
  const TOL = 5;
  const pad = { top: 14, bottom: 34, left: 44, right: 8 };
  const all = items.flatMap((r) => [r.check.fastest!, r.check.slowest!, r.check.target[0] - TOL, r.check.target[1] + TOL]);
  const lo = Math.min(...all) - 6;
  const hi = Math.max(...all) + 6;
  const y = (v: number) => pad.top + ((v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);
  const bw = (W - pad.left - pad.right) / items.length;
  const cx = (i: number) => pad.left + bw * (i + 0.5);
  const ticks: number[] = [];
  const stepS = hi - lo > 90 ? 30 : hi - lo > 40 ? 15 : 5;
  for (let t = Math.ceil(lo / stepS) * stepS; t <= hi; t += stepS) ticks.push(t);
  const count = (k: "fastest" | "slowest" | "actual", b: Band) => items.filter((r) => bandOf(r.check[k]!, r.check.target) === b).length;
  const h = hover != null ? items[hover] : null;
  return (
    <div className="interval-chart">
      <div className="interval-head">
        <h3>Key sessions against their target</h3>
        <span className="small muted">
          Average on target <b>{count("actual", "on")}/{items.length}</b> · fastest on target {count("fastest", "on")}/{items.length} · slowest on target {count("slowest", "on")}/{items.length} · {plural(count("fastest", "fast"), "session")} with a rep too quick ·{" "}
          {plural(count("slowest", "slow"), "session")} with one too slow
        </span>
      </div>
      <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" className="chart-label">
                {bpm ? Math.round(-t) : fmtPace(t)}
              </text>
            </g>
          ))}
          {items.map((r, i) => {
            const c = r.check;
            const x = cx(i);
            const w = Math.min(130, bw * 0.7);
            const fb = bandOf(c.fastest!, c.target);
            const sb = bandOf(c.slowest!, c.target);
            const ab = bandOf(c.actual, c.target);
            return (
              <g key={c.runId} onMouseEnter={() => setHover(i)} onClick={() => openRun(c.runId)} style={{ cursor: "pointer" }}>
                <rect x={x - bw / 2} y={pad.top} width={bw} height={H - pad.top - pad.bottom} fill="transparent" />
                <rect x={x - w / 2} y={y(c.target[0] - TOL)} width={w} height={Math.max(18, y(c.target[1] + TOL) - y(c.target[0] - TOL))} rx={6} className={"iv-band" + (c.autoZone ? " auto" : "")} />
                <rect x={x - 7} y={y(c.fastest!) - 7} width={14} height={Math.max(14, y(c.slowest!) - y(c.fastest!) + 14)} rx={7} className="iv-capsule" />
                <circle cx={x} cy={y(c.fastest!)} r={hover === i ? 7 : 5.5} className={`iv-dot iv-${fb}`} />
                <circle cx={x} cy={y(c.slowest!)} r={hover === i ? 7 : 5.5} className={`iv-dot iv-${sb}`} />
                <rect x={x - w / 2} y={y(c.actual) - 3} width={w} height={6} rx={3} className={`iv-avg iv-${ab}`} />
                {bw > 70 && (
                  <text x={x + w / 2 + 4} y={y(c.actual) + 4} className="chart-label iv-avg-label">
                    {fmtVal(c, c.actual, false)}
                  </text>
                )}
                {(i % Math.max(1, Math.ceil(46 / bw)) === 0 || hover === i) && (
                  <text x={x} y={H - pad.bottom + 16} textAnchor="middle" className={"chart-label" + (hover === i ? " hl" : "")}>
                    {fmt(c.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div className="chart-readout small">
          {h ? (
            <>
              <b>
                {h.day.dow} {fmt(h.check.date)}
              </b>{" "}
              {h.day.text} · average <b className="num">{fmtVal(h.check, h.check.actual)}</b> ({offText(h.check.actual, h.check.target, bpm)}) · {bpm ? "hardest" : "fastest"}{" "}
              <b className="num">{fmtVal(h.check, h.check.fastest!)}</b> ({offText(h.check.fastest!, h.check.target, bpm)}) · {bpm ? "easiest" : "slowest"} <b className="num">{fmtVal(h.check, h.check.slowest!)}</b> (
              {offText(h.check.slowest!, h.check.target, bpm)}) · target {fmtTarget(h.check)} · {h.check.measured}
            </>
          ) : (
            <span className="iv-legend">
              <span>
                <i className="iv-avg-l" /> average of the work
              </span>
              <span>
                <i className="iv-capsule-l" /> fastest to slowest interval
              </span>
              <span>
                <i className="iv-band-l" /> target range (±5 s)
              </span>
              <span>
                <i className="iv-band-l auto" /> before the plan: nearest training pace
              </span>
              <span>
                <i className="iv-dot-l iv-fast" /> {BAND_LABEL.fast}
              </span>
              <span>
                <i className="iv-dot-l iv-on" /> {BAND_LABEL.on}
              </span>
              <span>
                <i className="iv-dot-l iv-slow" /> {BAND_LABEL.slow}
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

