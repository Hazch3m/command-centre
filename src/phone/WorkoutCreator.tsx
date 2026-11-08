import { useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { addDays, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { forecastWeek } from "../modules/running/forecast";
import { useFitness } from "../modules/running/fitness";
import { mondayOf, upcomingRaces } from "../modules/running/plan";
import { pacesFor } from "../modules/running/planBuilder";
import { loadOverrides, setOverride } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { blocksOf, FOCUSES, setsOf, specKm, specText, suggestFocus, suggestions, withBlocks, withSets, type Block, type Focus, type RepSet, type Spec } from "../modules/running/workoutLibrary";
import { SendToWatch } from "../modules/watch/SendToWatch";
import { EffortProfile } from "./EffortProfile";
import { PlannedFocus, useFocusBasis } from "./Focus";
import { FILL, loadFocus } from "../modules/running/trainingFocus";
import { Section, useReadiness } from "./common";

const fmtP = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const CONTINUOUS: Focus[] = ["long", "easy", "recovery", "progression"];
/** Sessions made of reps (sets of them). */
const REPS: Focus[] = ["vo2", "threshold", "racepace", "fartlek", "hills"];

/** Create a workout: what to work on, a suggestion at your paces, your tweaks, then the watch or the plan. */
export function WorkoutCreator() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const ready = useReadiness(today);
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;

  // Your paces: from your race fitness (or one you entered), else the plan's.
  const vdot = f ? (f.predictionBasis?.source === "manual" ? f.predictionBasis.vdot : Math.max(f.current ?? 0, f.predictionBasis?.vdot ?? 0) || null) : null;
  const paces = useMemo(() => (vdot ? pacesFor(vdot) : null), [vdot]);
  const nextRace = plan ? upcomingRaces(plan, today)[0] : null;
  const raceDist = !nextRace ? "marathon" : /half/i.test(nextRace.name) ? "half" : /10\s?k/i.test(nextRace.name) ? "10k" : /5\s?k/i.test(nextRace.name) ? "5k" : "marathon";

  const basis = useFocusBasis();
  const lf = useMemo(() => (basis.ready ? loadFocus(runs, basis.details, basis.zones, basis.cuts, today) : null), [basis, runs, today]);
  // What to work on today: readiness, your last hard session and long run, and the plan.
  const tip = useMemo(() => {
    if (!plan) return null;
    const days = [0, 1].flatMap((n) => forecastWeek(plan, addDays(mondayOf(today), -7 * n), runs, overrides).days);
    const ago = (d: string) => Math.round((Date.parse(today) - Date.parse(d)) / 86400000);
    const hard = days.filter((d) => d.date < today && d.kind === "key" && d.runs.length).map((d) => d.date).sort().pop();
    const long = runs.filter((r) => r.date < today && r.distance >= 18000).map((r) => r.date).sort().pop();
    const planToday = days.find((d) => d.date === today);
    return suggestFocus({ readiness: ready?.score ?? null, hardDaysAgo: hard ? ago(hard) : null, longDaysAgo: long ? ago(long) : null, planToday: planToday?.km ? planToday.text : null, loadShort: lf?.short ? FILL[lf.short][0] : null });
  }, [plan, runs, overrides, today, ready?.score, lf?.short]);

  // A focus picked elsewhere (the load focus card's suggestion) opens here.
  const [focus, setFocus] = useState<Focus | null>(() => {
    try {
      const f = sessionStorage.getItem("cc-wc-focus") as Focus | null;
      sessionStorage.removeItem("cc-wc-focus");
      return f && FOCUSES.some((x) => x.id === f) ? f : null;
    } catch {
      return null;
    }
  });
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
              <PlannedFocus text={specText(o)} compact />
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
          <PlannedFocus text={text} label="Training focus" />
          <div className="p-session-text">{text.replace(/^\d+ km with /, "")}</div>

          {/* Rep sessions: one card per set; add more (a fartlek ladder, a VO2 set then a faster one). */}
          {REPS.includes(spec.focus) && (
            <div className="wc-sets">
              {setsOf(spec).map((x, k, all) => {
                const putSet = (patch: Partial<RepSet>) => put(withSets(spec, all.map((y, n) => (n === k ? { ...y, ...patch } : y))));
                return (
                  <div key={k} className="wc-set">
                    <div className="wc-set-head">
                      <b>{all.length > 1 ? `Set ${k + 1}` : "The reps"}</b>
                      {all.length > 1 && (
                        <button type="button" className="wc-x" onClick={() => put(withSets(spec, all.filter((_, n) => n !== k)))} aria-label={`Remove set ${k + 1}`}>
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="wc-tweaks">
                      <Stepper label="Reps" value={`${x.reps}`} dec={() => putSet({ reps: Math.max(1, x.reps - 1) })} inc={() => putSet({ reps: Math.min(30, x.reps + 1) })} />
                      <Stepper
                        label="Each rep"
                        exact={{ kind: x.timed ? "secs" : "m", value: x.size, set: (n) => putSet({ size: Math.round(n) }), min: x.timed ? 5 : 50, max: x.timed ? 3600 : 20000 }}
                        value={x.timed ? secsText(x.size) : x.size >= 1000 ? `${+(x.size / 1000).toFixed(2)} km` : `${x.size} m`}
                        dec={() => putSet({ size: Math.max(x.timed ? 15 : 100, x.size - (x.timed ? (x.size > 120 ? 60 : 15) : x.size >= 2000 ? 1000 : x.size >= 1000 ? 200 : 100)) })}
                        inc={() => putSet({ size: x.size + (x.timed ? (x.size >= 120 ? 60 : 15) : x.size >= 2000 ? 1000 : x.size >= 1000 ? 200 : 100) })}
                      />
                      <div className="wc-step wc-unit">
                        <span>Reps by</span>
                        <span className="wc-seg">
                          <button type="button" className={x.timed ? "on" : ""} onClick={() => !x.timed && putSet({ timed: true, size: 60 })}>
                            time
                          </button>
                          <button type="button" className={!x.timed ? "on" : ""} onClick={() => x.timed && putSet({ timed: false, size: 400 })}>
                            distance
                          </button>
                        </span>
                      </div>
                      {spec.focus !== "hills" && <Stepper label="Pace" value={x.pace ? `${fmtP(x.pace)}/km` : "by feel"} dec={() => putSet({ pace: (x.pace || paces.tenk) - 1 })} inc={() => putSet({ pace: (x.pace || paces.tenk) + 1 })} exact={{ kind: "pace", value: x.pace || Math.round(paces.tenk), set: (n) => putSet({ pace: n }), min: 120, max: 600 }} decLabel="Faster" incLabel="Slower" />}
                      {spec.focus !== "hills" && x.reps > 1 && (
                        <Stepper
                          label="Recovery"
                          exact={{ kind: "secs", value: x.rec, set: (n) => putSet({ rec: Math.round(n) }), min: 5, max: 900 }}
                          value={`${secsText(x.rec)} ${x.float ? "float" : "jog"}`}
                          dec={() => putSet({ rec: Math.max(15, x.rec - 15) })}
                          inc={() => putSet({ rec: Math.min(600, x.rec + 15) })}
                        />
                      )}
                      {spec.focus !== "hills" && x.reps > 1 && (
                        <div className="wc-step wc-unit">
                          <span>Recovery as</span>
                          <span className="wc-seg">
                            <button type="button" className={!x.float ? "on" : ""} onClick={() => putSet({ float: undefined })}>
                              jog
                            </button>
                            <button type="button" className={x.float ? "on" : ""} onClick={() => !x.float && putSet({ float: Math.round(paces.mp + 12) })}>
                              float
                            </button>
                          </span>
                        </div>
                      )}
                      {x.float ? <Stepper label="Float pace" value={`${fmtP(x.float)}/km`} dec={() => putSet({ float: x.float! - 1 })} inc={() => putSet({ float: x.float! + 1 })} exact={{ kind: "pace", value: x.float, set: (n) => putSet({ float: n }), min: 150, max: 600 }} decLabel="Faster" incLabel="Slower" /> : null}
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="wc-add"
                onClick={() => {
                  const all = setsOf(spec);
                  const last = all[all.length - 1];
                  // The next set: a step on (longer reps, or quicker for short ones), easy to change.
                  const next: RepSet = last.timed ? { ...last, size: last.size >= 120 ? last.size + 60 : last.size * 2, pace: last.pace ? last.pace + 5 : 0, reps: Math.max(2, last.reps - 1) } : { ...last, pace: last.pace ? last.pace - 3 : 0 };
                  put(withSets(spec, [...all, next]));
                }}
              >
                + Add a set
              </button>
            </div>
          )}

          {/* Over-unders: blocks of under/over pairs around threshold. */}
          {spec.focus === "overunder" && spec.ou && (
            <div className="wc-sets">
              <div className="wc-set">
                <div className="wc-set-head">
                  <b>Each block</b>
                  <span className="num">
                    {spec.ou.pairs} × ({spec.ou.under >= 60 ? `${spec.ou.under / 60} min` : `${spec.ou.under} s`} under + {spec.ou.over >= 60 ? `${spec.ou.over / 60} min` : `${spec.ou.over} s`} over)
                  </span>
                </div>
                <div className="wc-tweaks">
                  <Stepper label="Blocks" value={`${spec.reps}`} dec={() => put({ reps: Math.max(1, spec.reps - 1) })} inc={() => put({ reps: Math.min(6, spec.reps + 1) })} />
                  <Stepper label="Pairs per block" value={`${spec.ou.pairs}`} dec={() => put({ ou: { ...spec.ou!, pairs: Math.max(2, spec.ou!.pairs - 1) } })} inc={() => put({ ou: { ...spec.ou!, pairs: Math.min(10, spec.ou!.pairs + 1) } })} />
                  <Stepper label="Under" exact={{ kind: "secs", value: spec.ou.under, set: (n) => put({ ou: { ...spec.ou!, under: Math.round(n) } }), min: 10, max: 1200 }} value={secsText(spec.ou.under)} dec={() => put({ ou: { ...spec.ou!, under: Math.max(30, spec.ou!.under - 30) } })} inc={() => put({ ou: { ...spec.ou!, under: Math.min(600, spec.ou!.under + 30) } })} />
                  <Stepper label="Under pace" value={`${fmtP(spec.ou.underPace)}/km`} exact={{ kind: "pace", value: spec.ou.underPace, set: (n) => put({ ou: { ...spec.ou!, underPace: n } }), min: 120, max: 600 }} dec={() => put({ ou: { ...spec.ou!, underPace: spec.ou!.underPace - 2 } })} inc={() => put({ ou: { ...spec.ou!, underPace: spec.ou!.underPace + 2 } })} decLabel="Faster" incLabel="Slower" />
                  <Stepper label="Over" exact={{ kind: "secs", value: spec.ou.over, set: (n) => put({ ou: { ...spec.ou!, over: Math.round(n) } }), min: 5, max: 600 }} value={secsText(spec.ou.over)} dec={() => put({ ou: { ...spec.ou!, over: Math.max(15, spec.ou!.over - 15) } })} inc={() => put({ ou: { ...spec.ou!, over: Math.min(300, spec.ou!.over + 15) } })} />
                  <Stepper label="Over pace" value={`${fmtP(spec.ou.overPace)}/km`} exact={{ kind: "pace", value: spec.ou.overPace, set: (n) => put({ ou: { ...spec.ou!, overPace: n } }), min: 120, max: 600 }} dec={() => put({ ou: { ...spec.ou!, overPace: spec.ou!.overPace - 2 } })} inc={() => put({ ou: { ...spec.ou!, overPace: spec.ou!.overPace + 2 } })} decLabel="Faster" incLabel="Slower" />
                  {spec.reps > 1 && <Stepper exact={{ kind: "secs", value: spec.rec, set: (n) => put({ rec: Math.round(n) }), min: 10, max: 900 }} label="Between blocks" value={`${spec.rec >= 60 && spec.rec % 60 === 0 ? `${spec.rec / 60} min` : `${spec.rec} s`} jog`} dec={() => put({ rec: Math.max(30, spec.rec - 30) })} inc={() => put({ rec: Math.min(600, spec.rec + 30) })} />}
                </div>
              </div>
            </div>
          )}

          {/* Progression and long runs: an easy start, then each block (add as many as you like). */}
          {(spec.focus === "progression" || spec.focus === "long") && (
            <div className="wc-sets">
              <div className="wc-tweaks">
                <Stepper label="Distance" value={`${spec.km} km`} dec={() => put({ km: Math.max(blocksOf(spec).reduce((t, b) => t + b.km, 0) + 2, spec.km - 1) })} inc={() => put({ km: Math.min(45, spec.km + 1) })} />
              </div>
              <div className="wc-set wc-easy">
                <div className="wc-set-head">
                  <b>Easy start</b>
                  <span className="num">{Math.max(0, +(spec.km - blocksOf(spec).reduce((t, b) => t + b.km, 0)).toFixed(1))} km</span>
                </div>
              </div>
              {blocksOf(spec).map((b, k, all) => {
                const putBlock = (patch: Partial<Block>) => put(withBlocks(spec, all.map((y, n) => (n === k ? { ...y, ...patch } : y))));
                return (
                  <div key={k} className="wc-set">
                    <div className="wc-set-head">
                      <b>{all.length > 1 ? `Block ${k + 1}` : spec.focus === "long" ? "Fast finish" : "Faster block"}</b>
                      <button type="button" className="wc-x" onClick={() => put(withBlocks(spec, all.filter((_, n) => n !== k)))} aria-label={`Remove block ${k + 1}`} disabled={spec.focus === "progression" && all.length === 1}>
                        Remove
                      </button>
                    </div>
                    <div className="wc-tweaks">
                      <Stepper label="Distance" value={`${b.km} km`} dec={() => putBlock({ km: Math.max(1, b.km - 1) })} inc={() => putBlock({ km: Math.min(30, b.km + 1) })} />
                      <Stepper label="Pace" value={`${fmtP(b.pace)}/km`} exact={{ kind: "pace", value: b.pace, set: (n) => putBlock({ pace: n }), min: 120, max: 600 }} dec={() => putBlock({ pace: b.pace - 2 })} inc={() => putBlock({ pace: b.pace + 2 })} decLabel="Faster" incLabel="Slower" />
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                className="wc-add"
                onClick={() => {
                  const all = blocksOf(spec);
                  const last = all[all.length - 1];
                  // Each new block a little quicker than the last.
                  const next: Block = last ? { km: Math.max(1, Math.min(last.km, 3)), pace: last.pace - 10 } : { km: 4, pace: Math.round(paces.mp + 8) };
                  put(withBlocks(spec, [...all, next]));
                }}
              >
                + Add a {blocksOf(spec).length ? "faster block" : "fast finish"}
              </button>
            </div>
          )}

          <div className="wc-tweaks">
            {spec.focus === "tempo" && (
              <Stepper
                label="Length"
                exact={{ kind: "secs", value: spec.size, set: (n) => put({ size: Math.round(n) }), min: 120, max: 7200 }}
                value={secsText(spec.size)}
                dec={() => put({ size: Math.max(600, spec.size - 300) })}
                inc={() => put({ size: Math.min(3600, spec.size + 300) })}
              />
            )}
            {spec.focus === "tempo" && <Stepper label="Pace" value={`${fmtP(spec.pace)}/km`} exact={{ kind: "pace", value: spec.pace, set: (n) => put({ pace: n }), min: 120, max: 600 }} dec={() => put({ pace: spec.pace - 2 })} inc={() => put({ pace: spec.pace + 2 })} decLabel="Faster" incLabel="Slower" />}
            {(spec.focus === "easy" || spec.focus === "recovery") && <Stepper label="Distance" value={`${spec.km} km`} dec={() => put({ km: Math.max(3, spec.km - 1) })} inc={() => put({ km: Math.min(30, spec.km + 1) })} />}
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

type Exact = { kind: "pace" | "secs" | "km" | "m"; value: number; set: (n: number) => void; min?: number; max?: number };

/** Hold a button and it keeps going, quicker the longer you hold. */
function useHold(fn: () => void) {
  const t = useRef<number | null>(null);
  const cb = useRef(fn);
  cb.current = fn;
  const stop = () => {
    if (t.current) window.clearTimeout(t.current);
    t.current = null;
  };
  const start = () => {
    stop();
    cb.current();
    let n = 0;
    const tick = () => {
      cb.current();
      n++;
      t.current = window.setTimeout(tick, n > 12 ? 40 : n > 5 ? 80 : 140);
    };
    t.current = window.setTimeout(tick, 420);
  };
  useEffect(() => stop, []);
  return { onPointerDown: (e: RPointerEvent) => (e.preventDefault(), start()), onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop, onContextMenu: (e: RMouseEvent) => e.preventDefault() };
}

/** 45 s, 2 min, 1:35. */
const secsText = (v: number) => (v < 60 ? `${v} s` : v % 60 ? mmss(v) : `${v / 60} min`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
/** "3:47" → 227; "90" → 90 (seconds); "1.5" km; "850" m. */
function parseExact(kind: Exact["kind"], text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (kind === "pace" || kind === "secs") {
    const m = /^(\d+):(\d{1,2})$/.exec(t);
    if (m) return +m[1] * 60 + +m[2];
    const n = Number(t.replace(/\s*(s|sec|secs)$/i, ""));
    if (!Number.isFinite(n)) return null;
    return /min$/i.test(t) ? Number(t.replace(/\s*min$/i, "")) * 60 : n;
  }
  const n = Number(t.replace(/\s*(km|m)$/i, ""));
  return Number.isFinite(n) ? n : null;
}

/** − value +, holding to repeat; with `exact`, ±1 s for paces and tapping the value lets you type it to the second. */
function Stepper({ label, value, dec, inc, decLabel = "Less", incLabel = "More", exact }: { label: string; value: string; dec: () => void; inc: () => void; decLabel?: string; incLabel?: string; exact?: Exact }) {
  const [typing, setTyping] = useState<string | null>(null);
  // Fine steps: a second on paces, 5 s on times (type for exact), 0.1 km, 10 m.
  const step = exact ? { pace: 1, secs: exact.value < 60 ? 1 : 5, km: 0.1, m: 10 }[exact.kind] : 0;
  const clamp = (n: number) => Math.min(exact?.max ?? Infinity, Math.max(exact?.min ?? 1, n));
  const live = useRef(exact?.value ?? 0);
  live.current = exact?.value ?? 0;
  const down = useHold(exact ? () => exact.set(clamp(+(live.current - step).toFixed(2))) : dec);
  const up = useHold(exact ? () => exact.set(clamp(+(live.current + step).toFixed(2))) : inc);
  const commit = () => {
    if (exact && typing != null) {
      const n = parseExact(exact.kind, typing);
      if (n != null && n > 0) exact.set(clamp(n));
    }
    setTyping(null);
  };
  return (
    <div className="wc-step">
      <span>{label}</span>
      <button type="button" {...down} aria-label={`${decLabel}: ${label}`}>
        −
      </button>
      {exact && typing != null ? (
        <input
          className="wc-exact num"
          autoFocus
          inputMode={exact.kind === "pace" || exact.kind === "secs" ? "text" : "decimal"}
          value={typing}
          onChange={(e) => setTyping(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          aria-label={`${label}, exact`}
        />
      ) : exact ? (
        <button type="button" className="wc-val num" onClick={() => setTyping(exact.kind === "pace" || (exact.kind === "secs" && exact.value >= 60) ? mmss(exact.value) : String(exact.value))} aria-label={`${label}: ${value}, tap to type`}>
          {value}
        </button>
      ) : (
        <b className="num">{value}</b>
      )}
      <button type="button" {...up} aria-label={`${incLabel}: ${label}`}>
        +
      </button>
    </div>
  );
}
