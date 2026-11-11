import { useMemo } from "react";
import { addDays } from "../core/time";
import { forecastWeek, type ForecastDay, type ForecastWeek } from "../modules/running/forecast";
import { mondayOf, type Plan } from "../modules/running/plan";
import type { Run } from "../modules/running/strava";
import { sessionTitle } from "./Today";
import { DayBars } from "./DayBars";

const isRun = (d: ForecastDay) => d.kind !== "rest" && d.kind !== "optional" && (d.km ?? 0) > 0 && !/^rest\b/i.test(d.text);

/** Planned runs done in a row, counting back from today (rest days don't break it; today not yet run doesn't either). */
export function sessionStreak(plan: Plan, runs: Run[], today: string, overrides?: Map<string, string>): number {
  let n = 0;
  for (let m = mondayOf(today), w = 0; w < 26; m = addDays(m, -7), w++) {
    const days = forecastWeek(plan, m, runs, overrides).days.filter((d) => d.date <= today).reverse();
    for (const d of days) {
      if (!isRun(d)) continue;
      if (d.runs.length) n++;
      else if (d.date === today) continue;
      else return n;
    }
  }
  return n;
}

/** Whole weeks in a row (before this one) with at least 80% of the planned km run. */
export function weeksOnPlan(plan: Plan, runs: Run[], today: string, overrides?: Map<string, string>): number {
  let n = 0;
  for (let m = addDays(mondayOf(today), -7), w = 0; w < 52; m = addDays(m, -7), w++) {
    const f = forecastWeek(plan, m, runs, overrides);
    if (!f.plannedKm) break;
    if (f.actualKm >= f.plannedKm * 0.8) n++;
    else break;
  }
  return n;
}

/** A line for how the week is going, and for the run you just did. */
function cheer(fw: ForecastWeek, today: string, doneRuns: number, planned: number, left: ForecastDay[]): string {
  const t = fw.days.find((d) => d.date === today);
  const justDid = t && t.runs.length > 0 && isRun(t) ? t : null;
  const kind = justDid ? (justDid.kind === "long" ? "long" : justDid.kind === "key" ? "key" : /recovery/i.test(justDid.text) ? "recovery" : "easy") : null;
  const first = doneRuns === 1 && justDid;
  const lead = !justDid
    ? null
    : kind === "key"
      ? "Session done: that's the one that moves your fitness."
      : kind === "long"
        ? "Long run in the bank: the base of everything else."
        : kind === "recovery"
          ? "Recovery run done: easy days done right are what let the hard days work."
          : "Easy run done: this is where most of the aerobic gains come from.";
  const rest = left.length ? `${left.length} more run${left.length === 1 ? "" : "s"} this week${left[0] ? `; next: ${sessionTitle(left[0].text, left[0].kind)} ${left[0].date === addDays(today, 1) ? "tomorrow" : "on " + new Date(left[0].date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" })}` : ""}.` : doneRuns >= planned ? "Every run of the week done." : "";
  if (first) return `Day 1 done: the first one counts most. ${rest}`.trim();
  return [lead, rest].filter(Boolean).join(" ") || "A fresh week: one run at a time.";
}

/** One short line for Today: what's left this week and what's next. */
function nextUp(today: string, doneRuns: number, planned: number, left: ForecastDay[]): string {
  if (!left.length) return doneRuns >= planned && planned > 0 ? "Every run of the week done." : "Nothing more planned this week.";
  const n = left[0];
  const when = n.date === today ? "today" : n.date === addDays(today, 1) ? "tomorrow" : "on " + new Date(n.date + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long" });
  return `${left.length} run${left.length === 1 ? "" : "s"} to go · next: ${sessionTitle(n.text, n.kind)} ${when}`;
}

/** This week at a glance: how much of it you've trained, each day, and your streaks. */
export function WeekProgress({ plan, fw, runs, today, overrides, onDay, compact }: { plan: Plan; fw: ForecastWeek; runs: Run[]; today: string; overrides?: Map<string, string>; onDay?: (date: string) => void; compact?: boolean }) {
  const planned = fw.days.filter(isRun);
  // Runs done this week: planned ones, plus any extra day you ran.
  const doneRuns = fw.days.filter((d) => d.runs.length > 0 && d.date <= today).length;
  const left = planned.filter((d) => d.date > today || (d.date === today && !d.runs.length));
  const missed = planned.filter((d) => d.date < today && !d.runs.length).length;
  const km = fw.actualKm;
  const pk = fw.plannedKm ?? 0;
  const pct = pk ? Math.min(100, Math.round((km / pk) * 100)) : 0;
  const streak = useMemo(() => sessionStreak(plan, runs, today, overrides), [plan, runs, today, overrides]);
  const onPlan = useMemo(() => weeksOnPlan(plan, runs, today, overrides), [plan, runs, today, overrides]);
  const size = compact ? 54 : 70;
  const r = (size - 12) / 2;
  const c = 2 * Math.PI * r;
  return (
    <section className={"wp" + (compact ? " wp-c" : "")} aria-label="This week's progress">
      <div className="wp-top">
        <svg className="wp-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} className="wp-track" />
          <circle cx={size / 2} cy={size / 2} r={r} className="wp-fill" strokeDasharray={c} style={{ strokeDashoffset: c * (1 - pct / 100) }} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </svg>
        <span className="wp-pct">
          <b className="num">{pct}%</b>
          {!compact && <small>of the week</small>}
        </span>
        <span className="wp-nums">
          <span>
            <b className="num">{doneRuns}</b> of {planned.length} runs
          </span>
          <span>
            <b className="num">{km.toFixed(km < 10 ? 1 : 0)}</b> of {Math.round(pk)} km
          </span>
          {missed > 0 && <span className="wp-missed">{missed} missed</span>}
        </span>
        {compact && (streak > 0 || onPlan > 0) && (
          <span className="wp-chips">
            {streak > 0 && <span title="Planned runs in a row">🔥 {streak}</span>}
            {onPlan > 0 && <span title="Weeks in a row with 80% or more of the plan">{onPlan} wk on plan</span>}
          </span>
        )}
      </div>
      <DayBars days={fw.days} today={today} onDay={onDay} height={compact ? 32 : 46} />
      <p className="wp-cheer">{compact ? nextUp(today, doneRuns, planned.length, left) : cheer(fw, today, doneRuns, planned.length, left)}</p>
      {!compact && <div className="wp-streaks">
        <span>
          <b className="num">🔥 {streak}</b>
          <small>{streak ? (streak === 1 ? "planned run in a row" : "planned runs in a row") : "start a streak today"}</small>
        </span>
        <span>
          <b className="num">{onPlan}</b>
          <small>{onPlan === 1 ? "week" : "weeks"} on plan (80%+)</small>
        </span>
      </div>}
    </section>
  );
}
