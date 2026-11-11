import { useEffect, useMemo, useState } from "react";
import { addDays, diffDays, parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { fitnessConfigChanged, loadFitnessConfig, marathonShape, saveFitnessConfig, useFitness } from "./fitness";
import { plannedRuns } from "./FitnessPlan";
import { raceKm } from "./forecast";
import { mondayOf, priorityOf, restorePreviousPlan, savePlan, WEEK_KEYS, type Plan, type PlanRace } from "./plan";
import { buildPlan, doublesAdvice, DIST_M, expectedGain, courseElevation, elevationCost, DEFAULT_WEEKS, DIST_LABEL, GOALS, LEVELS, MAX_WEEKS, pacesFor, recommend, SESSION_KINDS, summarizeHistory, tuneDefaults, type BuildOptions, type Goal, type History, type Level, type RaceDist, type SessionKind, type Tune } from "./planBuilder";
import { raceReadiness } from "./readiness";
import { ReadinessView, useReadinessInputs } from "./ReadinessCard";
import { useRunningData } from "./useRunning";
import { predictTime, vdot } from "./vo2";
import { PracticeTag } from "./PracticeTag";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const fmtYear = (d: string) => `${fmt(d)} ${parseKey(d).getFullYear()}`;
const pace = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const DAY_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const PHASE_CLASS: Record<string, string> = { Base: "base", Build: "build", "Race-specific": "specific", Taper: "taper", "Race week": "taper" };

const DIST_KM: Record<RaceDist, number> = { "5k": 5, "10k": 10, half: 21.1, marathon: 42.2 };
const TAPER_LABEL = { full: "full taper", mini: "mini taper", none: "train through" } as const;
const defaultTaperFor = (r: PlanRace) => (priorityOf(r) === "A" ? "full" : priorityOf(r) === "B" ? "mini" : "none");

function distOf(name: string, km?: number): RaceDist {
  const k = km ?? raceKm(name);
  if (k == null) return "marathon";
  return k > 40 ? "marathon" : k > 20 ? "half" : k >= 9 ? "10k" : "5k";
}

function Chips<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; l: string; sub?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="ps-choice">
      {options.map((o) => (
        <button key={String(o.v)} type="button" className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)} title={o.sub}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

/**
 * Build a plan: looks at your recent training, suggests a level, days a week
 * and length for the race, and writes out a full plan you can preview and
 * switch to. Your current plan is kept so it can be brought back.
 */
export function PlanBuilder({ plan, compact }: { plan: Plan; compact?: boolean }) {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const f = useFitness(plan);
  const base: Plan = useMemo(() => ({ ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined, adjust: null }), [plan]);
  const firstMonday = mondayOf(today) < today ? addDays(mondayOf(today), 7) : mondayOf(today);
  // Paces start from your fitness now: current form, or your best race of the last year if that's higher.
  const fitNow = f ? (f.predictionBasis?.source === "manual" ? f.predictionBasis.vdot : Math.max(f.current ?? 0, f.predictionBasis?.vdot ?? 0) || null) : null;
  // No runs yet (a new account): a recent race or time trial, or a guess, sets the paces.
  const [manualV, setManualV] = useState<number | null>(null);
  const [manualRace, setManualRace] = useState<{ km: number; seconds: number } | null>(null);
  const fitUse = fitNow ?? manualV;
  const history = useMemo(() => summarizeHistory(runs, today, fitUse), [runs, today, fitUse]);
  // A plan that starts later builds on the weeks of your current plan before it: your training as it will be then.
  const atStartFor = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof summarizeHistory>>();
    return (raceDate: string) => (weeks: number) => {
      const avail = Math.max(1, diffDays(firstMonday, mondayOf(raceDate)) / 7 + 1);
      const start = addDays(firstMonday, Math.max(0, avail - weeks) * 7);
      if (start <= firstMonday) return history;
      if (!cache.has(start)) {
        const done = runs.filter((r) => r.date <= today);
        const planned = plannedRuns(base, today, addDays(start, -1));
        cache.set(start, summarizeHistory([...done, ...planned], start, fitUse));
      }
      return cache.get(start)!;
    };
  }, [history, runs, base, today, firstMonday, fitUse]);
  const races = useMemo(() => base.races.filter((r) => r.date && r.date > addDays(today, 21)), [base, today]);

  const [o, setO] = useState<BuildOptions | null>(null);
  const isRace = (o?.goal ?? "race") === "race";
  const available = o ? (isRace ? Math.max(1, diffDays(firstMonday, mondayOf(o.raceDate)) / 7 + 1) : 26) : 0;
  // What a marathon at your fitness needs each week (marathon shape's target), so the suggestion can aim for it.
  const needKm = useMemo(() => {
    if (!f || !o || o.dist !== "marathon") return null;
    const at = addDays(o.raceDate, -14);
    return marathonShape(f.runs, at, f.project(at) ?? f.current ?? 55).targetKm;
  }, [f, o?.dist, o?.raceDate]);
  const rec = useMemo(() => (o ? recommend(history, o.dist, available, firstMonday, needKm, atStartFor(o.raceDate)) : null), [history, o?.dist, o?.raceDate, available, firstMonday, needKm, atStartFor]);
  // Start from the plan's own settings if it was built here, else from the next big race and the recommendation.
  useEffect(() => {
    // Wait for your fitness to load; with no runs at all, start from the defaults.
    if (o || (!f && runs.length)) return;
    if (plan.built && plan.built.raceDate > today) {
      setO({ ...plan.built });
      return;
    }
    const goal = races.find((r) => /marathon/i.test(r.name) && !/half/i.test(r.name)) ?? races[0];
    const raceDate = goal?.date ?? addDays(today, 16 * 7);
    const dist = goal ? distOf(goal.name, goal.km) : "marathon";
    const avail = Math.max(1, diffDays(firstMonday, mondayOf(raceDate)) / 7 + 1);
    const at = addDays(raceDate, -14);
    const need = f && dist === "marathon" ? marathonShape(f.runs, at, f.project(at) ?? f.current ?? 55).targetKm : null;
    const r = recommend(history, dist, avail, firstMonday, need, atStartFor(raceDate));
    setO({ raceName: goal?.name ?? "", raceDate, dist, target: goal?.target ?? "", weeks: r.weeks, level: r.level, days: r.days, longDay: "sun", keepRaces: true });
  }, [runs.length, plan.built, races, history, today, firstMonday, o, f, atStartFor]);

  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [touched, setTouched] = useState(false);
  const [other, setOther] = useState(false);
  // The plan is only worked out on the review step, so choosing things doesn't make anything jump around.
  const built = useMemo(() => {
    if (!o || step < 3) return null;
    try {
      return buildPlan(base, o, atStartFor(o.raceDate)(o.weeks), today);
    } catch (e) {
      return { error: String((e as Error).message) } as const;
    }
  }, [base, o, atStartFor, today, step]);

  const { actual, vdotAt, ready } = useReadinessInputs(plan);
  const goalRace = o ? { date: o.raceDate, name: o.raceName || DIST_LABEL[o.dist], km: DIST_KM[o.dist], target: o.target, elevation: o.terrain ? courseElevation(o.terrain, DIST_KM[o.dist]) : undefined } : null;
  const readiness = useMemo(() => {
    if (!built || "error" in built || !goalRace || !ready) return null;
    return { next: raceReadiness(built.plan, goalRace, today, vdotAt, actual), now: raceReadiness(plan, goalRace, today, vdotAt, actual) };
  }, [built, ready, vdotAt, actual, today, plan]);

  if (!o || !rec) return <p className="muted">Looking at your training…</p>;

  const set = (patch: Partial<BuildOptions>, own = true) => {
    // A block that isn't for a race simply ends after its weeks.
    setO((x) => {
      if (!x) return x;
      const n = { ...x, ...patch };
      if ((n.goal ?? "race") !== "race" && ("weeks" in patch || "goal" in patch)) n.raceDate = addDays(firstMonday, n.weeks * 7 - 1);
      return n;
    });
    if (own && ("level" in patch || "days" in patch || "weeks" in patch)) setTouched(true);
    setArmed(false);
    setDone(null);
  };
  const recWeeks = Math.min(rec.weeks, available);
  const isRec = o.level === rec.level && o.days === rec.days && o.weeks === recWeeks;
  const startFor = (weeks: number) => addDays(firstMonday, Math.max(0, available - weeks) * 7);
  const start = startFor(o.weeks);
  const tuneUps = base.races.filter((r) => r.date && !r.approx && r.date >= start && r.date < o.raceDate);
  const chosen = races.find((r) => r.date === o.raceDate && r.name === o.raceName);
  const raceOk = !isRace || (!!o.raceDate && o.raceDate > addDays(today, 21));
  const pickGoal = (g: Goal) => {
    if (g === "race") {
      const r0 = races.find((r) => /marathon/i.test(r.name) && !/half/i.test(r.name)) ?? races[0];
      set({ goal: "race", raceName: r0?.name ?? "", raceDate: r0?.date ?? addDays(today, 16 * 7), dist: r0 ? distOf(r0.name, r0.km) : "marathon", target: r0?.target ?? "", tune: undefined }, false);
    } else {
      const spec = GOALS.find((x) => x.id === g)!;
      if (g === "start") {
        set({ goal: g, raceName: spec.label, target: "", weeks: spec.weeks, dist: "5k", level: "beginner", days: 3, tune: undefined }, true);
        return;
      }
      set({ goal: g, raceName: spec.label, target: "", weeks: spec.weeks, dist: g === "faster" ? (o.dist === "marathon" || o.dist === "half" ? "10k" : o.dist) : g === "recover" ? "10k" : "half", tune: undefined }, false);
    }
  };
  const next = (to: number) => {
    // Leaving the race step: the length, level and days follow the suggestion for that race unless you've set them.
    if (step === 0 && to > 0 && !touched && o.goal !== "start") set(isRace ? { level: rec.level, days: rec.days, weeks: recWeeks } : { level: rec.level, days: rec.days }, false);
    setStep(to);
  };
  const STEPS = ["Race", "Your training", "Plan", "Review"];

  const use = async () => {
    if (!built || "error" in built) return;
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await savePlan(built.plan);
      // A race time you gave (no runs yet) becomes your race fitness everywhere: paces, workouts, predictions.
      if (fitNow == null && manualRace) {
        const c = await loadFitnessConfig();
        await saveFitnessConfig({ ...c, manual: { ...manualRace, date: today, name: "Your race time" } });
        fitnessConfigChanged();
      }
      setDone(`Done: your plan now runs ${fmt(built.weeks[0].monday)} → ${o.raceName || DIST_LABEL[o.dist]} on ${fmt(o.raceDate)}.`);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };
  const restore = async () => {
    setBusy(true);
    try {
      await restorePreviousPlan();
      setDone("Your previous plan is back.");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={"plan-builder" + (compact ? " compact" : "")}>
      <ol className="pb-steps">
        {STEPS.map((t, i) => (
          <li key={t} className={(i === step ? "on" : i < step ? "done" : "") + (i > step && !raceOk ? " off" : "")}>
            <button type="button" disabled={i > step && !raceOk} onClick={() => next(i)}>
              <i>{i < step ? "✓" : i + 1}</i>
              <span>{t}</span>
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="ps-card pb-step">
          <h3>Suggested for you</h3>
          <p className="ps-note">{history.weeksRun12 > 0 ? "From your recent running: how long each would take, and where it could get you." : "From the fitness you give on the next step (or a beginner's start). Tap one to set it up; you can change the date."}</p>
          <div className="pb-suggest" data-noswipe>
            {(["5k", "10k", "half", "marathon"] as RaceDist[]).map((dist) => {
              const r = recommend(history, dist, 40, firstMonday);
              const date = addDays(firstMonday, r.weeks * 7 - 1);
              const v0 = fitUse;
              // "Now" is the same prediction shown everywhere else (Garmin's when synced, else your curve);
              // "then" moves it by what the block's expected gain is worth.
              const shown = f?.predictions.find((p) => Math.abs(p.distance - DIST_M[dist]) < 300)?.seconds ?? null;
              const vNow = v0 ? predictTime(DIST_M[dist], v0) : null;
              const now = shown ?? vNow;
              const then = v0 && now && vNow ? now * (predictTime(DIST_M[dist], v0 + expectedGain(r.weeks, r.level)) / vNow) : null;
              const early = (dist === "marathon" && history.recent12 < 25) || (dist === "half" && history.recent12 < 12);
              const on = isRace && o.dist === dist && o.raceDate === date;
              return (
                <button
                  key={dist}
                  type="button"
                  className={"pb-sug" + (on ? " on" : "") + (early ? " early" : "")}
                  onClick={() => {
                    setOther(true);
                    setTouched(true);
                    set({ goal: "race", raceName: `${DIST_LABEL[dist]} goal`, raceDate: date, dist, target: then ? fmtT(then) : "", weeks: r.weeks, level: r.level, days: r.days, tune: undefined }, false);
                  }}
                >
                  <b>{DIST_LABEL[dist]}</b>
                  <span>
                    {r.weeks} weeks · {r.days} days a week
                  </span>
                  <span className="muted">{LEVELS[r.level].label}</span>
                  {then && now ? (
                    <span className="pb-sug-t">
                      <b className="num">{fmtT(then)}</b>
                      <small className="num">now ~{fmtT(now)}</small>
                    </span>
                  ) : null}
                  {early && <small className="tone-warn">Build up regular running first</small>}
                  <small className="muted">Race day {fmt(date)}</small>
                </button>
              );
            })}
          </div>
          <h3>What's this block for?</h3>
          <div className="pb-goals">
            {GOALS.map((g) => (
              <button key={g.id} type="button" className={"pb-goal-pick" + ((o.goal ?? "race") === g.id ? " on" : "")} onClick={() => pickGoal(g.id)}>
                <b>{g.label}</b>
                <span>{g.blurb}</span>
              </button>
            ))}
          </div>
          {!isRace && (
            <div className="pb-other">
              {o.goal === "faster" && (
                <>
                  <span className="label">Faster at</span>
                  <Chips value={o.dist} options={(["5k", "10k", "half"] as RaceDist[]).map((d) => ({ v: d, l: DIST_LABEL[d] }))} onChange={(d) => set({ dist: d }, false)} />
                </>
              )}
              {o.goal === "start" && (
                <p className="ps-note">
                  No race or 5k time needed. Three sessions a week of running and walking, from 1-minute runs to 30 minutes without stopping. Run as slowly as you like.
                </p>
              )}
              <p className="ps-note">
                {GOALS.find((g) => g.id === o.goal)!.weeks} weeks suits this; set the length on the Plan step. It starts {fmt(firstMonday)}.
              </p>
            </div>
          )}
          {isRace && <h3>Which race?</h3>}
          {isRace && <div className="pb-race-list">
            {races.map((r) => {
              const on = !other && r.date === o.raceDate && r.name === o.raceName;
              const k = r.km ?? raceKm(r.name);
              return (
                <button
                  key={`${r.date}${r.name}`}
                  type="button"
                  className={"pb-race" + (on ? " on" : "")}
                  onClick={() => {
                    setOther(false);
                    set({ raceName: r.name, raceDate: r.date!, dist: distOf(r.name, r.km), target: r.target }, false);
                  }}
                >
                  <span className={"rm-pri pr-" + priorityOf(r)}>{priorityOf(r)}</span>
                  <span className="pb-race-main">
                    <b>{r.name}</b>
                    <span className="muted small">
                      {r.approx ? r.when : fmtYear(r.date!)}
                      {k ? ` · ${k} km` : ""}
                      {r.target ? ` · goal ${r.target}` : ""}
                    </span>
                  </span>
                  <span className="pb-radio" aria-hidden>
                    {on ? "●" : "○"}
                  </span>
                </button>
              );
            })}
            <button type="button" className={"pb-race" + (other || (!chosen && !races.length) ? " on" : "")} onClick={() => (setOther(true), set({ raceName: "", target: "" }, false))}>
              <span className="rm-pri">+</span>
              <span className="pb-race-main">
                <b>Another race</b>
                <span className="muted small">Any date at least three weeks away</span>
              </span>
              <span className="pb-radio" aria-hidden>
                {other ? "●" : "○"}
              </span>
            </button>
          </div>}
          {isRace && (other || (!chosen && !races.length)) && (
            <div className="pb-other">
              <div className="pb-fields">
                <label>
                  <span className="label">Name</span>
                  <input value={o.raceName} placeholder="e.g. Berlin Marathon" onChange={(e) => set({ raceName: e.target.value }, false)} />
                </label>
                <label>
                  <span className="label">Date</span>
                  <input type="date" value={o.raceDate} min={addDays(today, 22)} onChange={(e) => e.target.value && set({ raceDate: e.target.value }, false)} />
                </label>
                <label>
                  <span className="label">Goal time (optional)</span>
                  <input value={o.target} placeholder={o.dist === "marathon" ? "2:49" : o.dist === "half" ? "1:18:00" : "35:30"} onChange={(e) => set({ target: e.target.value }, false)} />
                </label>
              </div>
              <Chips value={o.dist} options={(["5k", "10k", "half", "marathon"] as RaceDist[]).map((d) => ({ v: d, l: DIST_LABEL[d] }))} onChange={(d) => set({ dist: d }, false)} />
            </div>
          )}
          {isRace && !other && chosen && (
            <label className="pb-goal">
              <span className="label">Goal time (optional)</span>
              <input value={o.target} onChange={(e) => set({ target: e.target.value }, false)} />
            </label>
          )}
          {isRace && <TerrainPick o={o} onChange={(terrain) => set({ terrain }, false)} />}
          {!raceOk && <p className="ps-note tone-warn">Pick a race at least three weeks away.</p>}
          <div className="pb-nav">
            <span />
            <button className="btn btn-primary" disabled={!raceOk} onClick={() => next(1)}>
              Next: your training ›
            </button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="ps-card pb-step pb-history">
          <h3>Where you are now</h3>
          {fitNow == null && <ManualFitness value={manualV} start={o.dist === "marathon" ? "half" : o.dist} onChange={(v, r) => (setManualV(v), setManualRace(r))} />}
          <div className="ps-stats">
            <div>
              <span className="label">Last 4 weeks</span>
              <b className="num">{Math.round(history.recent4)} km/week</b>
            </div>
            <div>
              <span className="label">Last 12 weeks</span>
              <b className="num">{Math.round(history.recent12)} km/week</b>
              <small className="muted">biggest {Math.round(history.peak12)}</small>
            </div>
            <div>
              <span className="label">Runs a week</span>
              <b className="num">{history.runsPerWeek.toFixed(1)}</b>
              <small className="muted">ran in {history.weeksRun12} of 12 weeks</small>
            </div>
            <div>
              <span className="label">Longest run (8 weeks)</span>
              <b className="num">{history.longest8.toFixed(1)} km</b>
            </div>
            <div>
              <span className="label">Fitness</span>
              <b className="num">{history.vdot != null ? `VDOT ${history.vdot.toFixed(1)}` : "–"}</b>
              {history.vdot != null && (
                <small className="muted">
                  marathon ≈ {fmtHms(predictTime(42195, history.vdot))} ({pace(pacesFor(history.vdot).mp)}/km)
                  {f?.predictionBasis?.race ? ` · from ${f.predictionBasis.source === "manual" ? "your entry" : f.predictionBasis.race.name}, ${fmt(f.predictionBasis.race.date)}` : " · from your training"}
                </small>
              )}
            </div>
          </div>
          <FitnessFrom />
          <div className="pb-rec">
            <div>
              <b>
                Suggested for {o.raceName || DIST_LABEL[o.dist]}: {LEVELS[rec.level].label}, {rec.days} days a week, {recWeeks} weeks
              </b>
              <ul className="bullets">
                {rec.why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </div>
          <div className="pb-nav">
            <button className="btn ghost" onClick={() => setStep(0)}>
              ‹ Race
            </button>
            <span className="inline">
              {!isRec && (
                <button className="btn" onClick={() => (set({ level: rec.level, days: rec.days, weeks: recWeeks }), setStep(3))}>
                  Use the suggestion
                </button>
              )}
              <button className="btn btn-primary" onClick={() => next(2)}>
                Next: choose the plan ›
              </button>
            </span>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="ps-card pb-step">
          <h3>Shape the plan</h3>
          <div className="pb-block">
            <h4>Level</h4>
            <div className="pb-levels">
              {(Object.keys(LEVELS) as Level[]).map((lv) => (
                <button key={lv} type="button" className={"pb-level" + (o.level === lv ? " on" : "")} onClick={() => set({ level: lv })}>
                  <b>
                    {LEVELS[lv].label}
                    {lv === rec.level && <span className="pill small">suggested</span>}
                  </b>
                  <span>{LEVELS[lv].blurb}</span>
                  <small className="num">
                    Peaks near {LEVELS[lv].peak[o.dist]} km · long runs to {LEVELS[lv].longCap[o.dist]} km
                  </small>
                </button>
              ))}
            </div>
          </div>
          <div className="pb-two">
            <div className="pb-block">
              <h4>Days a week</h4>
              <div className="pb-days-pick">
                {[3, 4, 5, 6, 7].map((n) => (
                  <button key={n} type="button" className={o.days === n ? "on" : ""} onClick={() => set({ days: n })}>
                    <b>{n}</b>
                    {n === rec.days && <small>suggested</small>}
                  </button>
                ))}
              </div>
              <Chips value={o.longDay} options={[{ v: "sat" as const, l: "Long run Saturday" }, { v: "sun" as const, l: "Long run Sunday" }]} onChange={(v) => set({ longDay: v })} />
            </div>
            <div className="pb-block">
              <h4>
                Length <span className="muted small">· starts {fmt(start)}</span>
              </h4>
              <div className="pb-weeks-pick">
                <input type="range" min={isRace ? Math.min(4, available) : 2} max={Math.min(MAX_WEEKS, available)} value={Math.min(o.weeks, available)} onChange={(e) => set({ weeks: +e.target.value })} aria-label="Weeks" />
                <b className="num">{Math.min(o.weeks, available)} weeks</b>
              </div>
              <p className="ps-note">
                {isRace ? <>{DEFAULT_WEEKS[o.dist]}–{DEFAULT_WEEKS[o.dist] + 6} weeks suits a {DIST_LABEL[o.dist].toLowerCase()}; a longer build spends the extra weeks on base mileage and ramps up more gently.</> : `${GOALS.find((g) => g.id === o.goal)!.weeks} weeks suits this block.`}{" "}
                {!isRace ? "" : available > o.weeks ? <button type="button" className="link-btn" onClick={() => set({ weeks: Math.min(MAX_WEEKS, available) })}>Start now ({Math.min(MAX_WEEKS, available)} weeks)</button> : null}{" "}
                {isRace && available > o.weeks ? `Your current plan carries on until ${fmt(start)}.` : "It starts next Monday."}
              </p>
            </div>
          </div>
          <FineTune o={o} h={atStartFor(o.raceDate)(o.weeks)} onChange={(tune) => set({ tune })} />
          {isRace && (
            <div className="pb-block">
              <h4>Other races in this time</h4>
              {tuneUps.length > 0 && (
                <label className="inline small">
                  <input type="checkbox" checked={o.keepRaces} onChange={(e) => set({ keepRaces: e.target.checked })} /> Keep the ones already in your plan as tune-ups
                </label>
              )}
              <div className="pb-tuneups">
                {o.keepRaces &&
                  tuneUps.map((r) => (
                    <span key={r.date + r.name} className="pb-tuneup">
                      <span className={"rm-pri pr-" + priorityOf(r)}>{priorityOf(r)}</span>
                      {r.name} <span className="muted small">{fmt(r.date!)} · {TAPER_LABEL[r.taper ?? defaultTaperFor(r)]}</span>
                    </span>
                  ))}
                {(o.extraRaces ?? []).map((r, i) => (
                  <span key={"x" + i} className="pb-tuneup">
                    <span className={"rm-pri pr-" + priorityOf(r)}>{priorityOf(r)}</span>
                    {r.name} <span className="muted small">{fmt(r.date!)} · {r.km} km · {TAPER_LABEL[r.taper ?? defaultTaperFor(r)]}</span>
                    <button type="button" className="link-btn small" onClick={() => set({ extraRaces: (o.extraRaces ?? []).filter((_x, j) => j !== i) })}>
                      remove
                    </button>
                  </span>
                ))}
              </div>
              <AddRace from={start} to={addDays(o.raceDate, -7)} onAdd={(r) => set({ extraRaces: [...(o.extraRaces ?? []), r].sort((a, b) => a.date!.localeCompare(b.date!)) })} />
            </div>
          )}
          <div className="pb-nav">
            <button className="btn ghost" onClick={() => setStep(1)}>
              ‹ Your training
            </button>
            <button className="btn btn-primary" onClick={() => next(3)}>
              Build and review ›
            </button>
          </div>
        </section>
      )}

      {step === 3 && (!built || "error" in built) && <ErrorNote error={built && "error" in built ? `Couldn't build the plan: ${built.error}` : null} />}
      {step === 3 && built && !("error" in built) && review()}
      {done && <div className="pb-done">{done}</div>}
      <ErrorNote error={err} />
    </div>
  );

  function review() {
    if (!built || "error" in built || !o) return null;
    const { plan: np, weeks } = built;
    const s0 = weeks[0]?.monday ?? firstMonday;
    const peak = Math.max(...weeks.map((w) => w.km));
    const longest = Math.max(...weeks.map((w) => w.long));
    const newWeeks = np.weeks.filter((w) => w.start >= s0 && w.start <= mondayOf(o.raceDate));
    const sessionsPerWeek = newWeeks.reduce((s, w) => s + WEEK_KEYS.filter((k) => /\bwith\b|progression run/.test(w.sessions[k] ?? "")).length, 0) / Math.max(1, newWeeks.length);
    const p0 = pacesFor(history.vdot ?? 42);
    const replaced = base.weeks.filter((w) => w.start >= s0 && w.start <= mondayOf(o.raceDate)).length;
    const bars = weeks.map((w, i) => ({
      label: compact ? (parseKey(w.monday).getDate() <= 7 ? MON[parseKey(w.monday).getMonth()] : "") : String(i + 1),
      value: w.km,
      planned: w.cut,
      title: `Week ${i + 1} (${fmt(w.monday)}), ${newWeeks[i]?.phase ?? w.phase}: ${w.km} km${w.long ? `, long run ${w.long} km` : ""}${w.cut ? " · easier week" : ""}`,
    }));
    const phaseSpans = newWeeks.reduce<{ name: string; n: number }[]>((acc, w) => {
      const name = w.phase === "Race week" ? "Taper" : w.phase;
      if (acc.length && acc[acc.length - 1].name === name) acc[acc.length - 1].n++;
      else acc.push({ name, n: 1 });
      return acc;
    }, []);
    return (
      <>
        <section className="ps-card ps-preview pb-step">
          <div className="ps-preview-head">
            <h3>
              {isRace ? o.raceName || DIST_LABEL[o.dist] : `${GOALS.find((g) => g.id === o.goal)!.label} block`} · {LEVELS[o.level].label}, {o.days} days a week
            </h3>
            <span className="ps-sub">
              {fmtYear(s0)} → {fmtYear(o.raceDate)} · {weeks.length} weeks
            </span>
          </div>
          {isRace && readiness?.next && (
            <div className="ip-compare">
              <ReadinessView r={readiness.next} compact={compact} />
              {readiness.now && (
                <div className="ip-old muted small">
                  Your current plan for this race: <b className="num">{readiness.now.score}%</b> ready.
                </div>
              )}
            </div>
          )}
          <div className="ps-stats">
            <div>
              <span className="label">First week</span>
              <b className="num">{weeks[0]?.km} km</b>
            </div>
            <div>
              <span className="label">Peak week</span>
              <b className="num">{peak} km</b>
            </div>
            <div>
              <span className="label">Longest run</span>
              <b className="num">{longest} km</b>
            </div>
            <div>
              <span className="label">Sessions a week</span>
              <b className="num">{sessionsPerWeek.toFixed(1)}</b>
            </div>
            <div>
              <span className="label">Easy / threshold pace</span>
              <b className="num">
                {pace(p0.easy[0])}–{pace(p0.easy[1])} / {pace(p0.threshold)}
              </b>
            </div>
          </div>
          <div className="pb-phases">
            {phaseSpans.map((p, i) => (
              <span key={i} className={"pb-phase " + (PHASE_CLASS[p.name] ?? "")} style={{ flex: p.n }}>
                {p.name} · {p.n}
              </span>
            ))}
          </div>
          <BarChart bars={bars} height={compact ? 130 : 160} unit=" km" showValues={!compact} />
          <p className="ps-note">Faint bars: easier weeks. Hover a bar for the week.</p>
          <details className="fold">
            <summary>Week by week</summary>
            <div className="pb-weeks">
              {newWeeks.map((w) => (
                <div key={w.start} className="pb-week">
                  <div className="pb-week-head">
                    <b>Week {w.week}</b> <span className="muted">{fmt(w.start)}</span> <span className={"pb-tag " + (PHASE_CLASS[w.phase] ?? "")}>{w.phase}</span>
                    <span className="num">{w.km} km</span>
                  </div>
                  <div className="pb-days">
                    {WEEK_KEYS.map((k, i) => (
                      <span key={k} className={/rest/i.test(w.sessions[k] ?? "Rest") ? "rest" : /\bwith\b|sprints|long run|MP/.test(w.sessions[k] ?? "") ? "hard" : ""}>
                        <i>{DAY_SHORT[i]}</i>
                        {w.sessions[k]}
                        <PracticeTag text={w.sessions[k] ?? ""} />
                      </span>
                    ))}
                  </div>
                  {w.notes && <div className="ps-note">{w.notes}</div>}
                </div>
              ))}
            </div>
          </details>
          <div className="pb-nav">
            <button className="btn ghost" onClick={() => setStep(2)}>
              ‹ Change the plan
            </button>
            <span className="inline">
              {plan.previous && (
                <button className="btn" disabled={busy} onClick={restore}>
                  Bring back my previous plan
                </button>
              )}
              <button className="btn btn-primary" disabled={busy} onClick={use}>
                {busy ? "Saving…" : armed ? `Tap again to replace ${replaced} week${replaced === 1 ? "" : "s"}` : "Use this plan"}
              </button>
            </span>
          </div>
          <p className="ps-note">Replaces your plan from {fmt(s0)} to race week; earlier weeks and weeks after the race stay. Your current plan is kept, so you can bring it back.</p>
        </section>
      </>
    );
  }
}

/** Your own numbers on top of the level: peak and first week, longest run, sessions, easier weeks, taper, long-run style. */
const fmtT = (sec: number) => {
  const r = Math.round(sec);
  const h = Math.floor(r / 3600);
  const m = Math.floor((r % 3600) / 60);
  const x = String(r % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};
const parseT = (t: string): number | null => {
  const p = t.trim().split(":").map((x) => +x);
  if (!p.length || p.some((x) => !Number.isFinite(x))) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 60;
};

/** No runs to go on yet: a recent race or time trial (or a fair guess) sets the paces. */
function ManualFitness({ value, onChange, start = "5k" }: { value: number | null; start?: RaceDist; onChange: (v: number | null, race: { km: number; seconds: number } | null) => void }) {
  const [dist, setDist] = useState<RaceDist>(start);
  const [t, setT] = useState("");
  const apply = (d: RaceDist, txt: string) => {
    const sec = parseT(txt);
    const ok = !!sec && sec > (DIST_M[d] / 1000) * 150;
    onChange(ok ? Math.round(vdot(DIST_M[d], sec!) * 10) / 10 : null, ok ? { km: DIST_M[d] / 1000, seconds: sec! } : null);
  };
  return (
    <div className="pb-manual">
      <b>No runs yet to go on</b>
      <span className="ps-note">Connect Garmin or Strava and your runs set this. For now: a recent race or time trial, or your best guess. Leave it empty to start as a beginner.</span>
      <div className="inline">
        <Chips value={dist} options={(["5k", "10k", "half"] as RaceDist[]).map((d) => ({ v: d, l: DIST_LABEL[d] }))} onChange={(d) => (setDist(d), apply(d, t))} />
        <input value={t} inputMode="numeric" placeholder={dist === "half" ? "1:55:00" : dist === "10k" ? "52:00" : "25:00"} onChange={(e) => (setT(e.target.value), apply(dist, e.target.value))} />
      </div>
      {value ? <span className="ps-note">That's a VDOT of about {value}: your paces start from there.</span> : null}
    </div>
  );
}

function FineTune({ o, h, onChange }: { o: BuildOptions; h: History; onChange: (t: Tune | undefined) => void }) {
  const d = tuneDefaults(h, o);
  const t = o.tune ?? {};
  const put = (patch: Partial<Tune>) => {
    const next = { ...t, ...patch };
    for (const k of Object.keys(next) as (keyof Tune)[]) if (next[k] === undefined) delete next[k];
    onChange(Object.keys(next).length ? next : undefined);
  };
  const changed = Object.keys(t).length;
  const slider = (key: "peakKm" | "startKm" | "longest", label: string, min: number, max: number, unit = "km") => {
    const v = t[key] ?? d[key];
    return (
      <label className="ft-row">
        <span className="ft-label">
          {label}
          {t[key] != null && (
            <button type="button" className="link-btn small" onClick={() => put({ [key]: undefined })}>
              reset
            </button>
          )}
        </span>
        <input type="range" min={min} max={max} value={v} onChange={(e) => put({ [key]: +e.target.value })} />
        <b className={"num" + (t[key] != null ? " tone-accent" : "")}>
          {v} {unit}
        </b>
      </label>
    );
  };
  return (
    <details className="pb-block fine-tune" open={changed > 0}>
      <summary>
        <h4>
          Fine-tune {changed > 0 && <span className="pill small">{changed} change{changed === 1 ? "" : "s"}</span>}
        </h4>
        <span className="ps-note">Your own peak, long runs, sessions, easier weeks and taper. Anything you leave follows the level.</span>
      </summary>
      {slider("peakKm", "Peak week", 20, 200)}
      {slider("startKm", "First week", 10, Math.max(30, t.peakKm ?? d.peakKm))}
      {slider("longest", "Longest run", 10, o.dist === "marathon" ? 42 : 32)}
      <label className="ft-row">
        <span className="ft-label">
          Mileage increase
          {t.growth != null && (
            <button type="button" className="link-btn small" onClick={() => put({ growth: undefined })}>
              reset
            </button>
          )}
        </span>
        <input type="range" min={2} max={12} value={Math.round((t.growth ?? d.growth) * 100)} onChange={(e) => put({ growth: +e.target.value / 100 })} />
        <b className={"num" + (t.growth != null ? " tone-accent" : "")}>{t.growth != null ? `${Math.round(t.growth * 100)}% a week` : `up to ${Math.round(d.growth * 100)}%`}</b>
      </label>
      <div className="ft-row">
        <span className="ft-label">Speed sessions a week</span>
        <Chips
          value={t.quality ?? d.quality}
          options={[
            { v: 1 as const, l: "1" },
            { v: 2 as const, l: "2" },
            ...(o.days >= 6 ? [{ v: 3 as const, l: "3" }] : []),
          ]}
          onChange={(v) => put({ quality: v === d.quality ? undefined : v })}
        />
      </div>
      <div className="ft-row ft-kinds">
        <span className="ft-label">Kinds of speed work</span>
        <div className="ps-choice">
          {SESSION_KINDS.map((k) => {
            const on = (t.kinds ?? d.kinds).includes(k.id);
            return (
              <button
                key={k.id}
                type="button"
                className={on ? "on" : ""}
                title={k.blurb}
                onClick={() => {
                  const cur = new Set<SessionKind>(t.kinds ?? d.kinds);
                  if (on) cur.delete(k.id);
                  else cur.add(k.id);
                  const list = SESSION_KINDS.map((x) => x.id).filter((x) => cur.has(x));
                  put({ kinds: list.length === SESSION_KINDS.length ? undefined : list.length ? list : t.kinds });
                }}
              >
                {on ? "✓ " : ""}
                {k.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="ft-row">
        <span className="ft-label">Hill sprints on easy days</span>
        <Chips value={(t.hillSprints ?? d.hillSprints) ? "on" : "off"} options={[{ v: "on", l: "Yes" }, { v: "off", l: "No" }]} onChange={(v) => put({ hillSprints: v === "on" ? true : undefined })} />
      </div>
      {(() => {
        const adv = doublesAdvice(t.peakKm ?? d.peakKm, o.days, o.level, h.weeksRun12);
        const v = t.doubles ?? 0;
        return (
          <div className="ft-row ft-doubles">
            <span className="ft-label">
              Doubles a week
              {adv.suggest > 0 && v !== adv.suggest && (
                <button type="button" className="link-btn small" onClick={() => put({ doubles: adv.suggest })}>
                  use {adv.suggest}
                </button>
              )}
            </span>
            <Chips value={String(v)} options={[0, 1, 2, 3, 4].map((n) => ({ v: String(n), l: n === 0 ? "None" : String(n) }))} onChange={(x) => put({ doubles: +x ? (+x as 1 | 2 | 3 | 4) : undefined })} />
            <span className="ps-note">
              A second short easy run (5–8 km) on the same day, on easy days first. {adv.suggest > 0 ? `Suggested: ${adv.suggest}. ` : ""}
              {adv.why} Keep them easy and at least 4–6 hours apart; none in easier weeks, the taper or race week. Your watch gets the main run; the second is a plain easy run.
            </span>
          </div>
        );
      })()}
      <div className="ft-row">
        <span className="ft-label">Sharpen for tune-up races</span>
        <Chips value={(t.sharpen ?? d.sharpen) ? "on" : "off"} options={[{ v: "on", l: "Yes" }, { v: "off", l: "No" }]} onChange={(v) => put({ sharpen: v === "on" ? undefined : false })} />
        <span className="ps-note">The two weeks before each B race swap one session for one at that race's pace, so the long build comes in blocks that each peak for a race.</span>
      </div>
      <div className="ft-row">
        <span className="ft-label">Strides after easy runs</span>
        <Chips value={(t.strides ?? d.strides) ? "on" : "off"} options={[{ v: "on", l: "Yes" }, { v: "off", l: "No" }]} onChange={(v) => put({ strides: v === "on" ? undefined : false })} />
      </div>
      <div className="ft-row">
        <span className="ft-label">Easier week</span>
        <Chips
          value={t.cutEvery ?? d.cutEvery}
          options={[
            { v: 3 as const, l: "Every 3rd" },
            { v: 4 as const, l: "Every 4th" },
            { v: 5 as const, l: "Every 5th" },
            { v: 0 as const, l: "None" },
          ]}
          onChange={(v) => put({ cutEvery: v === d.cutEvery ? undefined : v })}
        />
      </div>
      <div className="ft-row">
        <span className="ft-label">Taper</span>
        <Chips
          value={t.taperWeeks ?? d.taperWeeks}
          options={[
            { v: 1 as const, l: "1 week" },
            { v: 2 as const, l: "2 weeks" },
            { v: 3 as const, l: "3 weeks" },
          ]}
          onChange={(v) => put({ taperWeeks: v === d.taperWeeks ? undefined : v })}
        />
      </div>
      <div className="ft-row">
        <span className="ft-label">Medium-long run mid-week</span>
        <Chips value={(t.mediumLong ?? d.mediumLong) ? "on" : "off"} options={[{ v: "on", l: "Yes" }, { v: "off", l: "No" }]} onChange={(v) => put({ mediumLong: (v === "on") === d.mediumLong ? undefined : v === "on" })} />
      </div>
      {o.dist === "marathon" && (
        <div className="ft-row">
          <span className="ft-label">Marathon pace in long runs</span>
          <Chips value={(t.mpLong ?? d.mpLong) ? "on" : "off"} options={[{ v: "on", l: "Yes" }, { v: "off", l: "No" }]} onChange={(v) => put({ mpLong: v === "on" ? (d.mpLong ? undefined : true) : false })} />
        </div>
      )}
      {changed > 0 && (
        <button type="button" className="btn ghost small" onClick={() => onChange(undefined)}>
          Reset all to the level's
        </button>
      )}
    </details>
  );
}

const fmtHms = (sec: number) => {
  const t = Math.round(sec);
  return `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
};

/** "That's not my fitness": set it from a race result (or clear one you set). Paces, predictions and the plan use it. */
export function FitnessFrom() {
  const today = useToday();
  const [open, setOpen] = useState(false);
  const [km, setKm] = useState(42.195);
  const [time, setTime] = useState("");
  const [date, setDate] = useState(today);
  const [have, setHave] = useState<{ km: number; seconds: number; date: string } | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    loadFitnessConfig().then((c) => setHave(c.manual ?? null));
  }, [open]);
  const secs = (() => {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(time.trim());
    return m ? (+(m[1] ?? 0) * 3600 + +m[2] * 60 + +m[3]) : null;
  })();
  const save = async (manual: { km: number; seconds: number; date: string; name?: string } | null) => {
    setErr(null);
    try {
      const c = await loadFitnessConfig();
      await saveFitnessConfig({ ...c, manual });
      fitnessConfigChanged();
      setHave(manual);
      setOpen(false);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  };
  if (have === undefined) return null;
  return (
    <div className="fit-from">
      {have ? (
        <p className="ps-note">
          Using your {have.km === 42.195 ? "marathon" : have.km === 21.0975 ? "half marathon" : `${have.km} km`} of {fmtHms(have.seconds)} ({fmt(have.date)}).{" "}
          <button type="button" className="link-btn" onClick={() => save(null)}>
            Work it out from my runs instead
          </button>
        </p>
      ) : !open ? (
        <button type="button" className="link-btn small" onClick={() => setOpen(true)}>
          Not right? Set it from a race result
        </button>
      ) : null}
      {open && (
        <div className="pb-other">
          <Chips value={km} options={[{ v: 5, l: "5k" }, { v: 10, l: "10k" }, { v: 21.0975, l: "Half" }, { v: 42.195, l: "Marathon" }]} onChange={setKm} />
          <div className="pb-fields">
            <label>
              <span className="label">Time</span>
              <input value={time} onChange={(e) => setTime(e.target.value)} placeholder={km > 40 ? "3:00:00" : km > 20 ? "1:25:00" : km > 9 ? "38:30" : "18:30"} inputMode="numeric" />
            </label>
            <label>
              <span className="label">When</span>
              <input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
          </div>
          <div className="inline">
            <button type="button" className="btn btn-primary" disabled={!secs} onClick={() => secs && save({ km, seconds: secs, date })}>
              Use this result
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <p className="ps-note">Your paces, the plan and race predictions then come from this result for six months, or until you clear it.</p>
          <ErrorNote error={err} />
        </div>
      )}
    </div>
  );
}

/** The race course: flat, rolling, hilly, mountainous, or the exact climb and descent. */
function TerrainPick({ o, onChange }: { o: BuildOptions; onChange: (t: BuildOptions["terrain"]) => void }) {
  const kind = o.terrain?.kind ?? "flat";
  const km = DIST_KM[o.dist];
  const el = courseElevation(o.terrain ?? { kind: "flat" }, km);
  const cost = elevationCost(el.gain, el.loss);
  return (
    <div className="pb-block pb-terrain">
      <span className="label">Course</span>
      <Chips
        value={kind}
        options={[
          { v: "flat" as const, l: "Flat" },
          { v: "rolling" as const, l: "Rolling" },
          { v: "hilly" as const, l: "Hilly" },
          { v: "mountain" as const, l: "Mountainous" },
          { v: "custom" as const, l: "Exact climb" },
        ]}
        onChange={(k) => onChange(k === "flat" ? undefined : k === "custom" ? { kind: "custom", gain: el.gain, loss: el.loss } : { kind: k })}
      />
      {kind === "custom" && (
        <div className="pb-fields">
          <label>
            <span className="label">Climb (m)</span>
            <input type="number" min={0} value={o.terrain?.gain ?? 0} onChange={(e) => onChange({ kind: "custom", gain: +e.target.value, loss: o.terrain?.loss ?? +e.target.value })} />
          </label>
          <label>
            <span className="label">Descent (m)</span>
            <input type="number" min={0} value={o.terrain?.loss ?? 0} onChange={(e) => onChange({ kind: "custom", gain: o.terrain?.gain ?? 0, loss: +e.target.value })} />
          </label>
        </div>
      )}
      <p className="ps-note">
        {kind === "flat"
          ? "A flat course: no time added."
          : `About ${el.gain} m up and ${el.loss} m down: ${cost >= 0 ? `adds about ${Math.round(cost / 60)} min` : `about ${Math.round(-cost / 60)} min quicker`} to the predicted time${el.gain / km >= 8 ? "; the plan brings in more hill reps and hilly long runs" : el.gain / km >= 4 ? "; long runs late in the plan go on rolling roads" : ""}.`}
      </p>
    </div>
  );
}

/** Add a B or C race inside the plan: it gets the taper you choose and a lighter week around it. */
function AddRace({ from, to, onAdd }: { from: string; to: string; onAdd: (r: PlanRace) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState(from);
  const [km, setKm] = useState(10);
  const [pri, setPri] = useState<"B" | "C">("B");
  const [taper, setTaper] = useState<"mini" | "full" | "none">("mini");
  if (!open)
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        + Add a race
      </button>
    );
  const ok = name.trim() && date >= from && date <= to;
  return (
    <div className="pb-other">
      <div className="pb-fields">
        <label>
          <span className="label">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Geneva 10k" />
        </label>
        <label>
          <span className="label">Date</span>
          <input type="date" value={date} min={from} max={to} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>
      <Chips value={km} options={[{ v: 5, l: "5k" }, { v: 10, l: "10k" }, { v: 21.1, l: "Half" }, { v: 42.2, l: "Marathon" }]} onChange={setKm} />
      <Chips value={pri} options={[{ v: "B" as const, l: "B: run it well" }, { v: "C" as const, l: "C: training run" }]} onChange={(v) => (setPri(v), setTaper(v === "C" ? "none" : "mini"))} />
      <Chips value={taper} options={[{ v: "mini" as const, l: "Mini taper" }, { v: "full" as const, l: "Full taper" }, { v: "none" as const, l: "No taper" }]} onChange={setTaper} />
      <div className="inline">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!ok}
          onClick={() => {
            const d = new Date(date + "T12:00");
            onAdd({ name: name.trim(), date, approx: false, when: `${d.getDate()} ${MON[d.getMonth()]}`, target: "", role: pri === "B" ? "Tune-up race" : "Training race", priority: pri, taper, km });
            setName("");
            setOpen(false);
          }}
        >
          Add
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
