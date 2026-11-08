import { useMemo, useRef, useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { latestPredictions } from "../modules/health/data";
import { forecastWeek } from "../modules/running/forecast";
import { useFitness } from "../modules/running/fitness";
import { mondayOf, type Plan } from "../modules/running/plan";
import { fmtTime } from "../modules/running/pbs";
import { useReadiness } from "../modules/running/ReadinessCard";
import { readinessTone } from "../modules/running/readiness";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { predictTime } from "../modules/running/vo2";
import { Section } from "./common";
import { goalOptions, loadGoals, perKm, raceFor, type GoalOption } from "./PaceOnTrack";
import { RaceReady } from "./RaceReady";

/**
 * Your goals side by side: swipe across your races and 5K / 10K / Half / Marathon. Each card shows
 * now, race day and the goal; the one in view gets the full readiness below.
 */
export function GoalCarousel({ plan }: { plan: Plan }) {
  const today = useToday();
  const rv = useDataVersion("running");
  const goals = useQuery(loadGoals, [rv]).data ?? {};
  const { options, main } = goalOptions(plan, today);
  const [i, setI] = useState(0);
  const strip = useRef<HTMLDivElement | null>(null);
  const opt = options[Math.min(i, options.length - 1)];
  const onScroll = () => {
    const el = strip.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const w = (card?.offsetWidth ?? el.clientWidth) + 10;
    setI(Math.max(0, Math.min(options.length - 1, Math.round(el.scrollLeft / w))));
  };
  return (
    <>
      <div className="gc-strip" ref={strip} onScroll={onScroll} data-noswipe>
        {options.map((o, k) => (
          <GoalCard key={o.id} opt={o} mainDate={main?.date} goals={goals} active={k === i} onTap={() => strip.current?.scrollTo({ left: k * ((strip.current.firstElementChild as HTMLElement).offsetWidth + 10), behavior: "smooth" })} />
        ))}
      </div>
      <div className="hp-dots" role="tablist" aria-label="Goals">
        {options.map((o, k) => (
          <button key={o.id} role="tab" aria-selected={k === i} aria-label={o.label} className={k === i ? "on" : ""} onClick={() => strip.current?.scrollTo({ left: k * ((strip.current.firstElementChild as HTMLElement).offsetWidth + 10), behavior: "smooth" })} />
        ))}
      </div>
      {opt && <GoalReadiness key={opt.id} plan={plan} opt={opt} mainDate={main?.date} goals={goals} />}
    </>
  );
}

function GoalCard({ opt, mainDate, goals, active, onTap }: { opt: GoalOption; mainDate?: string | null; goals: Record<string, number>; active: boolean; onTap: () => void }) {
  const today = useToday();
  const { plan } = useRunningData();
  const race = useMemo(
    () => raceFor(opt, mainDate, goals, today),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opt.id, mainDate, goals[opt.id], today],
  );
  const r = useReadiness(plan, race);
  const goal = r?.goal ?? (goals[opt.id] || null);
  const days = Math.round((parseKey(race.date!).getTime() - parseKey(today).getTime()) / 86400000);
  return (
    <button type="button" className={"gc-card" + (active ? " on" : "")} onClick={onTap}>
      <span className="gc-head">
        <b>{opt.race ? opt.race.name : race.name}</b>
        <small>{opt.race ? `${days} days · ${parseKey(race.date!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "Standard distance"}</small>
      </span>
      {r ? (
        <span className="gc-times">
          <span>
            <small>Now</small>
            <b className="num">{r.now ? fmtTime(r.now) : "–"}</b>
          </span>
          <span className="gc-day">
            <small>Race day</small>
            <b className="num">{r.predicted ? fmtTime(r.predicted) : "–"}</b>
          </span>
          <span>
            <small>Goal</small>
            <b className="num">{goal ? fmtTime(goal) : "–"}</b>
          </span>
        </span>
      ) : (
        <span className="p-hint">Working it out…</span>
      )}
      {r && (
        <span className="gc-ready">
          <i className={readinessTone(r.today.score)} style={{ width: `${r.today.score}%` }} />
          <i className={"gc-ready-day " + readinessTone(r.score)} style={{ left: `${r.score}%` }} />
          <small>
            Ready today {r.today.score}% · race day {r.score}%
          </small>
        </span>
      )}
    </button>
  );
}

function GoalReadiness({ plan, opt, mainDate, goals }: { plan: Plan; opt: GoalOption; mainDate?: string | null; goals: Record<string, number> }) {
  const today = useToday();
  const race = useMemo(() => raceFor(opt, mainDate, goals, today), [opt, mainDate, goals, today]);
  const r = useReadiness(plan, race);
  return (
    <Section title={`Readiness · ${opt.race ? opt.race.name : race.name}`} className="p-padded">
      {r ? <RaceReady r={r} /> : <div className="p-hint">Working out your readiness…</div>}
    </Section>
  );
}

/** VO2 max now and its trend, and the race times it points to (with Garmin's, when synced). */
export function FitnessPredictor({ plan }: { plan: Plan }) {
  const f = useFitness(plan);
  const hv = useDataVersion("health");
  const garmin = useQuery(latestPredictions, [hv]).data;
  if (!f?.current) return null;
  // Garmin's race predictor leads when synced: it tracks race results well.
  const useG = !!garmin && Object.keys(garmin.values).length > 0;
  const shown = f.current + f.shift;
  const pts = f.weekly.filter((w) => w.smooth != null).slice(-16);
  const lo = Math.min(...pts.map((p) => p.smooth!)) - 0.5;
  const hi = Math.max(...pts.map((p) => p.smooth!)) + 0.5;
  const line = pts.map((p, k) => `${k ? "L" : "M"}${((k / Math.max(1, pts.length - 1)) * 100).toFixed(1)} ${(30 - ((p.smooth! - lo) / (hi - lo)) * 28).toFixed(1)}`).join("");
  const change = pts.length > 4 ? pts[pts.length - 1].smooth! - pts[pts.length - 5].smooth! : null;
  const rows: { name: string; m: number; key: string }[] = [
    { name: "5K", m: 5000, key: "5k" },
    { name: "10K", m: 10000, key: "10k" },
    { name: "Half", m: 21097.5, key: "Half" },
    { name: "Marathon", m: 42195, key: "Marathon" },
  ];
  return (
    <Section title="Fitness & race predictor" className="p-padded">
      <div className="fp-top">
        <span className="fp-vo2">
          <small>VO2 max</small>
          <b className="num">{shown.toFixed(1)}</b>
          {change != null && (
            <em className={change >= 0 ? "up" : "down"}>
              {change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(1)} in 4 weeks
            </em>
          )}
        </span>
        <svg className="fp-spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
          <path d={`${line}L100 32L0 32Z`} className="fp-fill" />
          <path d={line} className="fp-line" />
        </svg>
      </div>
      <div className="fp-table">
        <span className="fp-th">Distance</span>
        <span className="fp-th">{useG ? "Garmin" : "From your runs"}</span>
        <span className="fp-th">Pace</span>
        <span className="fp-th">{useG ? "Your runs" : ""}</span>
        {rows.map((r) => {
          const own = predictTime(r.m, f.current!);
          const g = garmin?.values[r.key];
          const t = useG && g ? g : own;
          return (
            <span key={r.name} className="fp-row">
              <b>{r.name}</b>
              <span className="num">{fmtTime(t)}</span>
              <span className="num muted">{perKm(t, r.m / 1000)}/km</span>
              <span className="num muted">{useG && g ? fmtTime(own) : ""}</span>
            </span>
          );
        })}
      </div>
      <p className="p-hint">{useG ? "Race times are Garmin's predictor (it tracks race results well); \"Your runs\" is the VO2 max worked out from your runs' pace and heart rate. " : "VO2 max from your runs' pace and heart rate, lined up with your races. "}Times are for a flat course on a good day. Pace on point and race readiness use the same times for "now".</p>
    </Section>
  );
}

/** Every week of the plan, planned against done: the weeks ahead too. */
export function PlanWeeksChart({ plan, first, last }: { plan: Plan; first: string; last: string }) {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const weeks = useMemo(() => {
    const out: { monday: string; planned: number; done: number; label: string; race: boolean }[] = [];
    for (let m = first; m <= last; m = addDays(m, 7)) {
      const w = forecastWeek(plan, m, runs, overrides);
      const d = parseKey(m);
      out.push({ monday: m, planned: w.plannedKm ?? 0, done: w.actualKm, label: w.week ? `W${w.week.week}` : `${d.getDate()}/${d.getMonth() + 1}`, race: w.days.some((x) => x.race) });
    }
    return out;
  }, [plan, first, last, runs, overrides]);
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.planned, w.done)));
  const thisMonday = mondayOf(today);
  const past = weeks.filter((w) => w.monday < thisMonday && w.planned > 0);
  const hit = past.filter((w) => w.done >= w.planned * 0.9).length;
  return (
    <>
      {past.length > 0 && (
        <p className="p-hint">
          {hit} of {past.length} weeks so far within 10% of the plan.
        </p>
      )}
      <div className="pp-weeks" data-noswipe>
        {weeks.map((w) => (
          <div key={w.monday} className={"pp-week" + (w.monday === thisMonday ? " now" : "") + (w.monday > thisMonday ? " future" : "")} title={`${w.label}: ${w.done.toFixed(0)} of ${w.planned} km`}>
            <span className="pp-bars">
              <i className="pp-plan" style={{ height: `${(w.planned / max) * 100}%` }} />
              <i className={"pp-done" + (w.planned && w.done >= w.planned * 0.9 ? " hit" : "")} style={{ height: `${(w.done / max) * 100}%` }} />
              {w.race && <b className="pp-flag">⚑</b>}
            </span>
            <small>{w.label}</small>
          </div>
        ))}
      </div>
      <div className="pp-key">
        <span>
          <i className="pp-plan" /> Planned
        </span>
        <span>
          <i className="pp-done hit" /> Done
        </span>
        <span>
          <i className="pp-plan pp-ahead" /> Ahead
        </span>
      </div>
    </>
  );
}
