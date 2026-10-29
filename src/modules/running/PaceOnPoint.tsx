import { useMemo } from "react";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { forecastWeek, type ForecastDay } from "./forecast";
import { checkDays, fmtPace, VERDICT_LABEL, type PaceCheck } from "./pace";
import { mondayOf, type Plan } from "./plan";
import { loadDetails, loadOverrides, type Run } from "./strava";

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
    }
    rows.sort((a, b) => b.check.date.localeCompare(a.check.date));
    const avg = (xs: PaceCheck[]) => (xs.length ? Math.round(xs.reduce((s, c) => s + c.score, 0) / xs.length) : null);
    return {
      rows,
      last14: avg(rows.filter((r) => r.check.date > addDays(today, -14)).map((r) => r.check)),
      onPointShare: rows.length ? rows.filter((r) => r.check.verdict === "on-point").length / rows.length : null,
      byWeek: [...new Set(rows.map((r) => mondayOf(r.check.date)))].map((w) => ({ week: w, score: avg(rows.filter((r) => mondayOf(r.check.date) === w).map((r) => r.check)) })),
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
      title={`${c.measured}: ${fmtPace(c.actual)}/km against ${fmtPace(c.target[0])}${c.target[1] !== c.target[0] ? `–${fmtPace(c.target[1])}` : ""}${c.inRange != null ? ` · ${Math.round(c.inRange * 100)}% of the work in range` : ""}`}
    >
      {VERDICT_LABEL[c.verdict]}
      {c.off !== 0 && c.verdict !== "on-point" ? ` ${c.off > 0 ? "+" : "−"}${Math.abs(Math.round(c.off))}s` : ""}
    </span>
  );
}

/** The "Pace on point" tab of the Training page. */
export function PaceOnPointTab({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const p = usePaceChecks(plan, runs, 8);
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
      {p.byWeek.length > 0 && (
        <div className="pace-weeks">
          {p.byWeek.map((w) => (
            <div key={w.week} className="pace-week">
              <span className="label">Week of {fmt(w.week)}</span>
              <span className="num">{w.score ?? "–"}%</span>
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
              <td className="num-col nowrap">
                {fmtPace(c.target[0])}
                {c.target[1] !== c.target[0] ? `–${fmtPace(c.target[1])}` : ""}
              </td>
              <td className="num-col">{fmtPace(c.actual)}</td>
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
