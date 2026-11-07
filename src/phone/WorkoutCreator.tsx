import { useMemo, useState } from "react";
import { addDays, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { forecastWeek } from "../modules/running/forecast";
import { useFitness } from "../modules/running/fitness";
import { mondayOf, upcomingRaces } from "../modules/running/plan";
import { pacesFor } from "../modules/running/planBuilder";
import { loadOverrides, setOverride } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { FOCUSES, specKm, specText, suggestFocus, suggestions, type Focus, type Spec } from "../modules/running/workoutLibrary";
import { SendToWatch } from "../modules/watch/SendToWatch";
import { EffortProfile } from "./EffortProfile";
import { Section, useReadiness } from "./common";

const fmtP = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const CONTINUOUS: Focus[] = ["long", "easy", "recovery", "progression"];

/** Create a workout: what to work on, a suggestion at your paces, your tweaks, then the watch or the plan. */
export function WorkoutCreator() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const ready = useReadiness(today).data;
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;

  // Your paces: from your race fitness (or one you entered), else the plan's.
  const vdot = f ? (f.predictionBasis?.source === "manual" ? f.predictionBasis.vdot : Math.max(f.current ?? 0, f.predictionBasis?.vdot ?? 0) || null) : null;
  const paces = useMemo(() => (vdot ? pacesFor(vdot) : null), [vdot]);
  const nextRace = plan ? upcomingRaces(plan, today)[0] : null;
  const raceDist = !nextRace ? "marathon" : /half/i.test(nextRace.name) ? "half" : /10\s?k/i.test(nextRace.name) ? "10k" : /5\s?k/i.test(nextRace.name) ? "5k" : "marathon";

  // What to work on today: readiness, your last hard session and long run, and the plan.
  const tip = useMemo(() => {
    if (!plan) return null;
    const days = [0, 1].flatMap((n) => forecastWeek(plan, addDays(mondayOf(today), -7 * n), runs, overrides).days);
    const ago = (d: string) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
    const hard = days.filter((d) => d.date < today && d.kind === "key" && d.runs.length).map((d) => d.date).sort().pop();
    const long = runs.filter((r) => r.date < today && r.distance >= 18000).map((r) => r.date).sort().pop();
    const planToday = days.find((d) => d.date === today);
    return suggestFocus({ readiness: ready?.score ?? null, hardDaysAgo: hard ? ago(hard) : null, longDaysAgo: long ? ago(long) : null, planToday: planToday?.km ? planToday.text : null });
  }, [plan, runs, overrides, today, ready?.score]);

  const [focus, setFocus] = useState<Focus | null>(null);
  const active = focus ?? tip?.focus ?? "threshold";
  const options = useMemo(() => (paces ? suggestions(active, paces, raceDist) : []), [active, paces, raceDist]);
  const [picked, setPicked] = useState<Spec | null>(null);
  const spec = picked && picked.focus === active ? picked : (options[1] ?? null);
  const [date, setDate] = useState(today);
  const [saved, setSaved] = useState<string | null>(null);
  const [prev, setPrev] = useState<string | null>(null);

  if (!paces) return <p className="p-hint">Your paces come from your race fitness: run (or enter) a race result under Stats → Race fitness, and workouts are made at your paces.</p>;
  const text = spec ? specText(spec) : "";
  const put = (patch: Partial<Spec>) => spec && (setPicked({ ...spec, ...patch }), setSaved(null));
  const meta = FOCUSES.find((x) => x.id === active)!;
  const planned = overrides?.get(date);

  return (
    <div className="p-screen wc">
      {tip && (
        <button type="button" className={`wc-tip z-${FOCUSES.find((x) => x.id === tip.focus)!.zone}`} onClick={() => (setFocus(tip.focus), setPicked(null))}>
          <span className="p-session-label">Suggested for today</span>
          <b>{FOCUSES.find((x) => x.id === tip.focus)!.label}</b>
          <span>{tip.why}</span>
        </button>
      )}

      <Section title="What do you want to work on?">
        <div className="wc-focus" data-noswipe>
          {FOCUSES.map((x) => (
            <button key={x.id} type="button" className={`wc-chip z-${x.zone}` + (active === x.id ? " on" : "")} onClick={() => (setFocus(x.id), setPicked(null), setSaved(null))}>
              {x.label}
            </button>
          ))}
        </div>
        <p className="p-hint">{meta.what}.</p>
      </Section>

      <div className="wc-options">
        {options.map((o) => {
          const on = spec?.name === o.name;
          return (
            <button key={o.name} type="button" className={`wc-option z-${meta.zone}` + (on ? " on" : "")} onClick={() => (setPicked(o), setSaved(null))}>
              <span className="wc-option-head">
                <b>{o.name}</b>
                <span className="num">{specKm(o)} km</span>
              </span>
              <EffortProfile text={specText(o)} plan={plan} height={30} />
            </button>
          );
        })}
      </div>

      {spec && (
        <div className={`p-session wc-preview z-${meta.zone}`}>
          <div className="p-session-top">
            <span className="p-session-label">Your workout</span>
            <span className="p-zone-pill">{meta.label}</span>
          </div>
          <div className="p-session-km num">
            {specKm(spec)}
            <small>km</small>
          </div>
          <EffortProfile text={text} plan={plan} />
          <div className="p-session-text">{text.replace(/^\d+ km with /, "")}</div>

          <div className="wc-tweaks">
            {!CONTINUOUS.includes(spec.focus) && spec.focus !== "tempo" && <Stepper label="Reps" value={`${spec.reps}`} dec={() => put({ reps: Math.max(1, spec.reps - 1) })} inc={() => put({ reps: Math.min(30, spec.reps + 1) })} />}
            {!CONTINUOUS.includes(spec.focus) && (
              <Stepper
                label={spec.focus === "tempo" ? "Length" : "Each rep"}
                value={spec.timed ? (spec.size % 60 ? `${spec.size} s` : `${spec.size / 60} min`) : spec.size >= 1000 ? `${+(spec.size / 1000).toFixed(1)} km` : `${spec.size} m`}
                dec={() => put({ size: Math.max(spec.timed ? 15 : 100, spec.size - (spec.timed ? (spec.size > 120 ? 60 : 15) : spec.size >= 2000 ? 1000 : spec.size >= 1000 ? 200 : 100)) })}
                inc={() => put({ size: spec.size + (spec.timed ? (spec.size >= 120 ? 60 : 15) : spec.size >= 2000 ? 1000 : spec.size >= 1000 ? 200 : 100) })}
              />
            )}
            {CONTINUOUS.includes(spec.focus) && <Stepper label="Distance" value={`${spec.km} km`} dec={() => put({ km: Math.max(3, spec.km - 1), fast: Math.min(spec.fast, Math.max(0, spec.km - 4)) })} inc={() => put({ km: Math.min(45, spec.km + 1) })} />}
            {(spec.focus === "long" || spec.focus === "progression") && <Stepper label="Fast finish" value={spec.fast ? `last ${spec.fast} km` : "none"} dec={() => put({ fast: Math.max(spec.focus === "progression" ? 1 : 0, spec.fast - 1) })} inc={() => put({ fast: Math.min(spec.km - 3, spec.fast + 1), pace: spec.pace || Math.round(paces.mp + 8) })} />}
            {spec.pace > 0 && (spec.focus !== "long" || spec.fast > 0) && <Stepper label="Pace" value={`${fmtP(spec.pace)}/km`} dec={() => put({ pace: spec.pace - 2 })} inc={() => put({ pace: spec.pace + 2 })} decLabel="Faster" incLabel="Slower" />}
            {!CONTINUOUS.includes(spec.focus) && spec.focus !== "tempo" && spec.focus !== "hills" && spec.reps > 1 && <Stepper label="Recovery" value={spec.rec >= 60 && spec.rec % 60 === 0 ? `${spec.rec / 60} min jog` : `${spec.rec} s jog`} dec={() => put({ rec: Math.max(15, spec.rec - 15) })} inc={() => put({ rec: Math.min(600, spec.rec + 15) })} />}
            {!CONTINUOUS.includes(spec.focus) && <Stepper label="Warm-up" value={`${spec.warm} km`} dec={() => put({ warm: Math.max(1, spec.warm - 1) })} inc={() => put({ warm: Math.min(6, spec.warm + 1) })} />}
            {!CONTINUOUS.includes(spec.focus) && <Stepper label="Cool-down" value={`${spec.cool} km`} dec={() => put({ cool: Math.max(1, spec.cool - 1) })} inc={() => put({ cool: Math.min(6, spec.cool + 1) })} />}
            {spec.focus === "easy" && <Stepper label="Strides" value={`${spec.reps} × 20 s`} dec={() => put({ reps: Math.max(4, spec.reps - 1) })} inc={() => put({ reps: Math.min(10, spec.reps + 1) })} />}
          </div>

          <div className="wc-when">
            <span className="p-session-label">When</span>
            <div className="ps-choice" data-noswipe>
              {[today, addDays(today, 1), addDays(today, 2)].map((d, i) => (
                <button key={d} type="button" className={date === d ? "on" : ""} onClick={() => (setDate(d), setSaved(null))}>
                  {i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(d + "T12:00").toLocaleDateString("en-GB", { weekday: "short" })}
                </button>
              ))}
              <input type="date" value={date} min={today} onChange={(e) => e.target.value && (setDate(e.target.value), setSaved(null))} aria-label="Another day" />
            </div>
          </div>
          <SendToWatch date={date} text={text} />
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              setPrev(overrides?.get(date) ?? null);
              await setOverride(date, text);
              setSaved(date);
            }}
          >
            {saved === date ? "In your plan ✓" : planned ? "Replace that day in my plan" : "Put it in my plan"}
          </button>
          {saved === date && (
            <button type="button" className="link-btn small" onClick={async () => (await setOverride(date, prev), setSaved(null))}>
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Stepper({ label, value, dec, inc, decLabel = "Less", incLabel = "More" }: { label: string; value: string; dec: () => void; inc: () => void; decLabel?: string; incLabel?: string }) {
  return (
    <div className="wc-step">
      <span>{label}</span>
      <button type="button" onClick={dec} aria-label={`${decLabel}: ${label}`}>
        −
      </button>
      <b className="num">{value}</b>
      <button type="button" onClick={inc} aria-label={`${incLabel}: ${label}`}>
        +
      </button>
    </div>
  );
}
