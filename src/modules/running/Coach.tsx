import { useMemo, useState } from "react";
import { useDataVersion } from "../../core/events";
import { addDays, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { loadHealth } from "../health/data";
import { sessionTitle } from "../../phone/Today";
import { recoveryOf, todayAdvice, trackOf, weekLines, type CoachLine, type Tone } from "./coach";
import { useFitness } from "./fitness";
import { forecastWeek, type ForecastDay } from "./forecast";
import { usePaceChecks } from "./PaceOnPoint";
import { mondayOf, priorityOf, upcomingRaces, type Plan } from "./plan";
import { raceDistance } from "./readiness";
import { setOverride, type Run } from "./strava";

const MARK: Record<Tone, string> = { good: "✓", warn: "!", bad: "✕", info: "·" };
const title = (d: ForecastDay) => (d.race ? d.race.name : sessionTitle(d.text, d.kind));

/** Everything the coach says, worked out once for wherever it's shown. */
export function useCoach(plan: Plan | null | undefined, runs: Run[]) {
  const today = useToday();
  const hv = useDataVersion("health");
  const health = useQuery(() => loadHealth(30), [hv]).data;
  const checks = usePaceChecks(plan ?? undefined, runs, 4);
  const f = useFitness(plan ?? undefined);
  return useMemo(() => {
    if (!plan || !checks) return null;
    const monday = mondayOf(today);
    const all = checks.rows.map((r) => r.check);
    const fw = forecastWeek(plan, monday, runs, checks.overrides);
    const last = forecastWeek(plan, addDays(monday, -7), runs, checks.overrides);
    const next = forecastWeek(plan, addDays(monday, 7), runs, checks.overrides);
    const recovery = recoveryOf(health ?? [], today);
    const races = upcomingRaces(plan, today);
    const race = races.find((r) => priorityOf(r) === "A") ?? races[0] ?? null;
    let track = null;
    if (race) {
      const km = raceDistance(race);
      const p = f?.predictions.length ? [...f.predictions].sort((a, b) => Math.abs((a.distance > 100 ? a.distance / 1000 : a.distance) - km) - Math.abs((b.distance > 100 ? b.distance / 1000 : b.distance) - km))[0] : null;
      const near = p && Math.abs((p.distance > 100 ? p.distance / 1000 : p.distance) - km) / km < 0.15 ? p : null;
      const three = [1, 2, 3].map((n) => forecastWeek(plan, addDays(monday, -7 * n), runs, checks.overrides)).filter((w) => w.week && (w.plannedKm ?? 0) > 0);
      const planned = three.reduce((s, w) => s + (w.plannedKm ?? 0), 0);
      track = trackOf({
        raceName: race.name,
        km,
        target: race.target,
        daysTo: race.days,
        now: near?.seconds ?? null,
        monthAgo: near?.secondsMonthAgo ?? null,
        completion: planned > 0 ? three.reduce((s, w) => s + w.actualKm, 0) / planned : null,
      });
    }
    const keys = next.days.filter((d) => d.kind === "key" || d.kind === "long" || d.race);
    return {
      today,
      track,
      race,
      week: weekLines(fw, all, today),
      advice: todayAdvice(fw, today, recovery, title),
      recovery,
      todayDay: fw.days.find((d) => d.date === today) ?? null,
      review: last.week && (last.plannedKm ?? 0) > 0 ? weekLines(last, all, monday) : null,
      next: next.week ? `Next week: ${Math.round(next.plannedKm ?? 0)} km${keys.length ? `, with ${keys.map((d) => `${title(d).toLowerCase()} on ${d.dow}`).join(", ")}` : ""}.` : null,
    };
  }, [plan, runs, checks, health, f, today]);
}

function Lines({ lines }: { lines: CoachLine[] }) {
  return (
    <ul className="coach-lines">
      {lines.map((l) => (
        <li key={l.label} className={`tone-${l.tone}`}>
          <span className="coach-mark" aria-hidden="true">
            {MARK[l.tone]}
          </span>
          <span className="coach-line">
            <span>
              <b>{l.label}</b> <span className="coach-detail">{l.detail}</span>
            </span>
            {l.fix && <small>{l.fix}</small>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "How am I doing": on track for the goal, the week line by line, what to do today, and last week's
 * review. `wide` lays the three out side by side (web); otherwise they stack (phone).
 */
export function CoachCard({ plan, runs, wide }: { plan: Plan; runs: Run[]; wide?: boolean }) {
  const c = useCoach(plan, runs);
  const [busy, setBusy] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [open, setOpen] = useState(false);
  if (!c) return null;
  const swap = async () => {
    const a = c.todayDay;
    const b = c.advice.swapWith;
    if (!a || !b) return;
    setBusy(true);
    try {
      await setOverride(a.date, b.text);
      await setOverride(b.date, a.text);
      setSwapped(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={"coach" + (wide ? " coach-wide" : "")} aria-label="How you're doing">
      <div className="coach-grid">
        {c.track && (
          <div className={`coach-box tone-${c.track.tone}`}>
            <span className="coach-eyebrow">Your goal{c.race ? ` · ${c.race.name}` : ""}</span>
            <b className="coach-verdict">{c.track.verdict}</b>
            <p>{c.track.detail}</p>
            {c.track.fix && <p className="coach-fix">{c.track.fix}</p>}
          </div>
        )}
        <div className={`coach-box tone-${c.week.score == null ? "info" : c.week.score >= 85 ? "good" : c.week.score >= 60 ? "warn" : "bad"}`}>
          <span className="coach-eyebrow">This week</span>
          <b className="coach-verdict">
            {c.week.score == null ? "Just starting" : c.week.score >= 85 ? "Going well" : c.week.score >= 60 ? "Mostly there" : "Off the plan"}
            {c.week.score != null && <span className="coach-score num">{c.week.score}</span>}
          </b>
          {c.week.lines.length ? <Lines lines={c.week.lines} /> : <p>Nothing to judge yet: the first run of the week starts it.</p>}
        </div>
        <div className={`coach-box tone-${c.advice.tone}`}>
          <span className="coach-eyebrow">Today</span>
          <b className="coach-verdict">{swapped ? "Swapped" : c.advice.headline}</b>
          <p>{swapped ? "Today is now the easy run; the session has moved." : c.advice.detail}</p>
          {c.advice.swapWith && !swapped && (
            <button type="button" className="btn small btn-primary coach-act" onClick={swap} disabled={busy}>
              {busy ? "Swapping…" : `Swap with ${c.advice.swapWith.dow}'s easy run`}
            </button>
          )}
          {c.recovery.level !== "unknown" && !c.recovery.reasons.length && <p className="coach-fix">Sleep, HRV and resting heart rate all look normal.</p>}
        </div>
      </div>
      {c.review && (
        <div className="coach-review">
          <button type="button" className="coach-review-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span>
              <b>Last week's review</b>
              {c.review.score != null && <span className="coach-score num">{c.review.score}</span>}
            </span>
            <span className="coach-chev">{open ? "–" : "+"}</span>
          </button>
          {open && (
            <>
              <Lines lines={c.review.lines} />
              {c.next && <p className="coach-next">{c.next}</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
