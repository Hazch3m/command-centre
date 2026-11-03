import { useEffect, useMemo, useState } from "react";
import { addDays, diffDays, parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { marathonShape, useFitness } from "./fitness";
import { plannedRuns } from "./FitnessPlan";
import { raceKm } from "./forecast";
import { mondayOf, restorePreviousPlan, savePlan, WEEK_KEYS, type Plan } from "./plan";
import { buildPlan, DEFAULT_WEEKS, DIST_LABEL, LEVELS, pacesFor, recommend, summarizeHistory, type BuildOptions, type Level, type RaceDist } from "./planBuilder";
import { useRunningData } from "./useRunning";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const fmtYear = (d: string) => `${fmt(d)} ${parseKey(d).getFullYear()}`;
const pace = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;
const DAY_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const PHASE_CLASS: Record<string, string> = { Base: "base", Build: "build", "Race-specific": "specific", Taper: "taper", "Race week": "taper" };

function distOf(name: string): RaceDist {
  const k = raceKm(name);
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
  const history = useMemo(() => summarizeHistory(runs, today, f?.current ?? null), [runs, today, f?.current]);
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
        cache.set(start, summarizeHistory([...done, ...planned], start, f?.current ?? null));
      }
      return cache.get(start)!;
    };
  }, [history, runs, base, today, firstMonday, f?.current]);
  const races = useMemo(() => base.races.filter((r) => r.date && r.date > addDays(today, 21)), [base, today]);

  const [o, setO] = useState<BuildOptions | null>(null);
  const available = o ? Math.max(1, diffDays(firstMonday, mondayOf(o.raceDate)) / 7 + 1) : 0;
  // What a marathon at your fitness needs each week (marathon shape's target), so the suggestion can aim for it.
  const needKm = useMemo(() => {
    if (!f || !o || o.dist !== "marathon") return null;
    const at = addDays(o.raceDate, -14);
    return marathonShape(f.runs, at, f.project(at) ?? f.current ?? 55).targetKm;
  }, [f, o?.dist, o?.raceDate]);
  const rec = useMemo(() => (o ? recommend(history, o.dist, available, firstMonday, needKm, atStartFor(o.raceDate)) : null), [history, o?.dist, o?.raceDate, available, firstMonday, needKm, atStartFor]);
  // Start from the plan's own settings if it was built here, else from the next big race and the recommendation.
  useEffect(() => {
    if (o || !runs.length || !f) return;
    if (plan.built && plan.built.raceDate > today) {
      setO({ ...plan.built });
      return;
    }
    const goal = races.find((r) => /marathon/i.test(r.name) && !/half/i.test(r.name)) ?? races[0];
    const raceDate = goal?.date ?? addDays(today, 16 * 7);
    const dist = goal ? distOf(goal.name) : "marathon";
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
  const set = (patch: Partial<BuildOptions>) => {
    setO((x) => (x ? { ...x, ...patch } : x));
    setArmed(false);
    setDone(null);
  };

  const built = useMemo(() => {
    if (!o) return null;
    try {
      return buildPlan(base, o, atStartFor(o.raceDate)(o.weeks), today);
    } catch (e) {
      return { error: String((e as Error).message) } as const;
    }
  }, [base, o, atStartFor, today]);

  const shape = useMemo(() => {
    if (!f || !o || o.dist !== "marathon" || !built || "error" in built) return null;
    const at = addDays(o.raceDate, -14);
    const level = f.project(at) ?? f.current ?? 55;
    const done = f.runs.filter((r) => r.date <= today);
    const now = marathonShape([...done, ...plannedRuns(base, today, at)], at, level).total;
    const next = marathonShape([...done, ...plannedRuns(built.plan, today, at)], at, level).total;
    return { now: Math.round(now * 100), next: Math.round(next * 100) };
  }, [f, o, built, base, today]);

  if (!o || !rec) return <p className="muted">Looking at your training…</p>;
  if (!built || "error" in built) return <ErrorNote error={built && "error" in built ? `Couldn't build the plan: ${built.error}` : null} />;

  const { plan: next, weeks } = built;
  const start = weeks[0]?.monday ?? firstMonday;
  const peak = Math.max(...weeks.map((w) => w.km));
  const longest = Math.max(...weeks.map((w) => w.long));
  const newWeeks = next.weeks.filter((w) => w.start >= start && w.start <= mondayOf(o.raceDate));
  const sessionsPerWeek =
    newWeeks.reduce((s, w) => s + WEEK_KEYS.filter((k) => /\bwith\b|hill sprints/.test(w.sessions[k] ?? "")).length, 0) / Math.max(1, newWeeks.length);
  const p0 = pacesFor(history.vdot ?? 42);
  const replaced = base.weeks.filter((w) => w.start >= start && w.start <= mondayOf(o.raceDate)).length;
  const isRec = o.level === rec.level && o.days === rec.days && o.weeks === Math.min(rec.weeks, available);
  const tuneUps = base.races.filter((r) => r.date && !r.approx && r.date >= start && r.date < o.raceDate);

  const use = async () => {
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await savePlan(next);
      setDone(`Your plan now runs ${fmt(start)} → ${o.raceName || DIST_LABEL[o.dist]} on ${fmt(o.raceDate)}.`);
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
    <div className={"plan-builder" + (compact ? " compact" : "")}>
      <section className="ps-card pb-history">
        <h4>Your training</h4>
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
            {history.vdot != null && <small className="muted">marathon pace ≈ {pace(p0.mp)}/km</small>}
          </div>
        </div>
        <div className="pb-rec">
          <div>
            <b>Suggested for this race:</b> {LEVELS[rec.level].label}, {rec.days} days a week, {Math.min(rec.weeks, available)} weeks.
            <ul className="bullets">
              {rec.why.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
          <button className={"btn" + (isRec ? "" : " btn-primary")} disabled={isRec} onClick={() => set({ level: rec.level, days: rec.days, weeks: Math.min(rec.weeks, available) })}>
            {isRec ? "Using the suggestion" : "Use the suggestion"}
          </button>
        </div>
      </section>

      <div className="ps-grid">
        <section className="ps-card">
          <h4>Race</h4>
          <Chips
            value={races.some((r) => r.date === o.raceDate && r.name === o.raceName) ? `${o.raceDate}|${o.raceName}` : "other"}
            options={[...races.map((r) => ({ v: `${r.date}|${r.name}`, l: r.name.replace(/ Marathon$/, " M."), sub: `${r.when}${r.target ? ` · ${r.target}` : ""}` })), { v: "other", l: "Another race" }]}
            onChange={(v) => {
              if (v === "other") return set({ raceName: "", target: "" });
              const r = races.find((x) => `${x.date}|${x.name}` === v)!;
              const dist = distOf(r.name);
              set({ raceName: r.name, raceDate: r.date!, dist, target: r.target, weeks: Math.min(o.weeks, Math.max(1, diffDays(firstMonday, mondayOf(r.date!)) / 7 + 1)) });
            }}
          />
          <div className="pb-fields">
            <label>
              <span className="label">Name</span>
              <input value={o.raceName} placeholder="e.g. Berlin Marathon" onChange={(e) => set({ raceName: e.target.value })} />
            </label>
            <label>
              <span className="label">Date</span>
              <input type="date" value={o.raceDate} min={addDays(today, 21)} onChange={(e) => e.target.value && set({ raceDate: e.target.value })} />
            </label>
            <label>
              <span className="label">Goal time (optional)</span>
              <input value={o.target} placeholder={o.dist === "marathon" ? "2:49" : o.dist === "half" ? "1:18:00" : "35:30"} onChange={(e) => set({ target: e.target.value })} />
            </label>
          </div>
          <Chips value={o.dist} options={(["5k", "10k", "half", "marathon"] as RaceDist[]).map((d) => ({ v: d, l: DIST_LABEL[d] }))} onChange={(d) => set({ dist: d })} />
        </section>

        <section className="ps-card">
          <h4>How long</h4>
          <div className="ps-value num">
            {Math.min(o.weeks, available)} weeks<small> · from {fmt(start)}</small>
          </div>
          <Chips
            value={Math.min(o.weeks, available)}
            options={[...new Set([6, 8, 10, 12, 14, 16, 18, 20, 24, available].filter((n) => n <= available && n <= 30 && n >= 4))]
              .sort((a, b) => a - b)
              .map((n) => ({ v: n, l: n === available ? `${n} (from now)` : String(n) }))}
            onChange={(n) => set({ weeks: n })}
          />
          <p className="ps-note">
            {DEFAULT_WEEKS[o.dist]}+ weeks suits a {DIST_LABEL[o.dist].toLowerCase()}.{" "}
            {available > o.weeks ? `Your current plan carries on until ${fmt(start)}.` : ""} Weeks after the race stay as they are in your current plan.
          </p>
          <h4>Days a week</h4>
          <div className="ps-value num">
            {o.days} days<small> · long run on {o.longDay === "sat" ? "Saturday" : "Sunday"}</small>
          </div>
          <Chips value={o.days} options={[3, 4, 5, 6, 7].map((n) => ({ v: n, l: String(n) }))} onChange={(n) => set({ days: n })} />
          <Chips value={o.longDay} options={[{ v: "sat" as const, l: "Long run Saturday" }, { v: "sun" as const, l: "Long run Sunday" }]} onChange={(v) => set({ longDay: v })} />
        </section>
      </div>

      <section className="ps-card">
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
        {tuneUps.length > 0 && (
          <label className="inline small pb-keep">
            <input type="checkbox" checked={o.keepRaces} onChange={(e) => set({ keepRaces: e.target.checked })} /> Keep my other races as tune-ups ({tuneUps.map((r) => r.name).join(", ")})
          </label>
        )}
      </section>

      <section className="ps-card ps-preview">
        <div className="ps-preview-head">
          <h4>Your new plan</h4>
          <span className="ps-sub">
            {fmtYear(start)} → {fmtYear(o.raceDate)}
          </span>
        </div>
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
            <span className="label">Easy / threshold</span>
            <b className="num">
              {pace(p0.easy[0])}–{pace(p0.easy[1])} / {pace(p0.threshold)}
            </b>
          </div>
          {shape && (
            <div>
              <span className="label">Marathon shape, 2 weeks out</span>
              <b className={"num " + (shape.next >= 100 ? "tone-accent" : shape.next < shape.now ? "tone-warn" : "")}>
                {shape.now}% → {shape.next}%
              </b>
              <small className="muted">current plan → new</small>
            </div>
          )}
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
                    </span>
                  ))}
                </div>
                {w.notes && <div className="ps-note">{w.notes}</div>}
              </div>
            ))}
          </div>
        </details>
      </section>

      <div className="ps-actions">
        <button className="btn btn-primary" disabled={busy} onClick={use}>
          {busy ? "Saving…" : armed ? `Tap again to replace ${replaced} week${replaced === 1 ? "" : "s"} of your plan` : "Use this plan"}
        </button>
        {plan.previous && (
          <button className="btn" disabled={busy} onClick={restore}>
            Bring back my previous plan
          </button>
        )}
        <span className="ps-note">
          Replaces your plan from {fmt(start)} to race week; earlier weeks and weeks after the race stay. Your current plan is kept, so you can bring it back. The training calendar,
          Google Calendar and the phone follow.
        </span>
      </div>
      {done && <div className="pb-done">{done}</div>}
      <ErrorNote error={err} />
    </div>
  );
}
