import { useMemo, useState } from "react";
import { addDays, parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { marathonShape, useFitness } from "./fitness";
import { forecastWeek } from "./forecast";
import { plannedRuns } from "./FitnessPlan";
import { mondayOf, savePlanAdjust, WEEK_KEYS, type DayKey, type Plan } from "./plan";
import { ADJUST_DEFAULTS, applyAdjust, isAdjusted, nextMonday, planDefaults, planStats, type PlanAdjust } from "./planAdjust";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABEL: Record<DayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;

function Choice<T extends string | number | null>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="ps-choice">
      {options.map((o) => (
        <button key={String(o.v)} type="button" className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

/**
 * Plan settings, like Runna's: weekly mileage, long runs and which days you
 * run, with a before/after preview. Saved alongside the plan (it isn't
 * rewritten), so it can be changed or undone any time. Also explains how the
 * plan is put together.
 */
export function PlanSettings({ plan, compact }: { plan: Plan; compact?: boolean }) {
  const today = useToday();
  const base: Plan = useMemo(() => ({ ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined, adjust: null }), [plan]);
  const defaults = useMemo(() => planDefaults(base, mondayOf(today)), [base, today]);
  const [a, setA] = useState<PlanAdjust>(() => plan.adjust ?? { ...ADJUST_DEFAULTS, from: nextMonday(today) });
  const days = a.runDays ?? defaults.runDays;
  const longDay = a.longDay ?? defaults.longDay;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (patch: Partial<PlanAdjust>) => {
    setA((x) => ({ ...x, ...patch }));
    setSaved(false);
  };
  const f = useFitness(plan);

  const after = useMemo(() => (isAdjusted(a) ? applyAdjust({ ...base, adjust: a }) : base), [base, a]);
  const last = base.weeks[base.weeks.length - 1]?.start ?? today;
  const before = useMemo(() => planStats(base, a.from, last), [base, a.from, last]);
  const now = useMemo(() => planStats(after, a.from, last), [after, a.from, last]);
  const goals = f?.config.projection.milestones ?? [];
  const shapes = useMemo(() => {
    if (!f) return [];
    return goals.map((m) => {
      const at = addDays(m.date, -14);
      const level = f.project(at) ?? f.current ?? 55;
      const done = f.runs.filter((r) => r.date <= today);
      const s1 = marathonShape([...done, ...plannedRuns(base, today, at)], at, level).total;
      const s2 = marathonShape([...done, ...plannedRuns(after, today, at)], at, level).total;
      return { label: m.label.split(" · ")[1] ?? m.label, before: Math.round(s1 * 100), after: Math.round(s2 * 100) };
    });
  }, [f, base, after, today]);

  const toggleDay = (k: DayKey) => {
    const has = days.includes(k);
    if (has && (days.length <= 3 || k === longDay)) return;
    set({ runDays: has ? days.filter((x) => x !== k) : WEEK_KEYS.filter((x) => x === k || days.includes(x)) });
  };
  const save = async (next: PlanAdjust | null) => {
    setBusy(true);
    setErr(null);
    try {
      await savePlanAdjust(next && isAdjusted(next) ? next : null);
      if (!next) setA({ ...ADJUST_DEFAULTS, from: nextMonday(today) });
      setSaved(true);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const changed = isAdjusted(a);
  const bars = now.weeks.map((w, i) => ({
    label: parseKey(w.monday).getDate() <= 7 ? MON[parseKey(w.monday).getMonth()] : "",
    value: w.km,
    target: before.weeks[i]?.km ?? null,
    title: `Week of ${fmt(w.monday)}: ${w.km} km (plan ${before.weeks[i]?.km ?? "–"}), longest ${w.long} km, ${w.runs} runs`,
  }));

  return (
    <div className={"plan-settings" + (compact ? " compact" : "")}>
      <div className="ps-grid">
        <section className="ps-card">
          <h4>Weekly mileage</h4>
          <div className="ps-value num">
            {Math.round(a.volume * 100)}%<small> of the plan · peak {now.peak} km</small>
          </div>
          <input type="range" min={0.8} max={1.25} step={0.05} value={a.volume} onChange={(e) => set({ volume: +e.target.value })} aria-label="Weekly mileage" />
          <div className="ps-scale">
            <span>80%</span>
            <span>100%</span>
            <span>125%</span>
          </div>
        </section>

        <section className="ps-card">
          <h4>Build-up</h4>
          <div className="ps-value num">
            {(a.ramp ?? 0) > 0 ? `${a.ramp} weeks sooner` : "As planned"}
            <small> · peak {now.peak} km</small>
          </div>
          <Choice value={a.ramp ?? 0} options={[0, 1, 2, 3, 4, 6].map((v) => ({ v, l: v === 0 ? "As planned" : `${v} wk` }))} onChange={(v) => set({ ramp: v || undefined })} />
          <div className="ps-sub">Reach the plan's weekly mileage sooner: for when you're coming off a higher-mileage block. Easier weeks still dip, the taper and race weeks are untouched, and nothing goes above the plan's peak.</div>
        </section>

        <section className="ps-card">
          <h4>Long runs</h4>
          <div className="ps-value num">
            {a.longExtra > 0 ? "+" : ""}
            {a.longExtra} km<small> · longest {now.longest} km</small>
          </div>
          <Choice value={a.longExtra} options={[-4, -2, 0, 2, 4, 6].map((v) => ({ v, l: v === 0 ? "As planned" : `${v > 0 ? "+" : ""}${v}` }))} onChange={(v) => set({ longExtra: v })} />
          <div className="ps-sub">No longer than</div>
          <Choice value={a.longMax} options={[null, 26, 28, 30, 32, 34, 36].map((v) => ({ v, l: v == null ? "No limit" : `${v} km` }))} onChange={(v) => set({ longMax: v })} />
        </section>

        <section className="ps-card">
          <h4>Days you run</h4>
          <div className="ps-value num">
            {days.length} days<small> a week{a.runDays ? "" : " (as planned)"}</small>
          </div>
          <div className="ps-days">
            {WEEK_KEYS.map((k) => (
              <button key={k} type="button" className={(days.includes(k) ? "on" : "") + (k === longDay ? " long" : "")} onClick={() => toggleDay(k)} aria-pressed={days.includes(k)}>
                {DAY_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="ps-sub">Long run on</div>
          <Choice
            value={a.longDay}
            options={[{ v: null, l: "As planned" }, ...(["sat", "sun"] as DayKey[]).map((v) => ({ v, l: v === "sat" ? "Saturday" : "Sunday" }))]}
            onChange={(v) => set({ longDay: v, runDays: !v || days.includes(v) ? a.runDays : WEEK_KEYS.filter((x) => x === v || days.includes(x)) })}
          />
          {a.runDays && (
            <button type="button" className="btn ghost small" onClick={() => set({ runDays: null })}>
              Run days as planned
            </button>
          )}
          <p className="ps-note">Sessions stay on their day if you run then, else move to the nearest run day (not next to the long run). Easy runs fill the rest of the week.</p>
        </section>
      </div>

      <section className="ps-card ps-preview">
        <div className="ps-preview-head">
          <h4>What it does to the plan</h4>
          <span className="ps-sub">
            from{" "}
            <Choice value={a.from} options={[{ v: mondayOf(today), l: "this week" }, { v: nextMonday(today), l: "next week" }]} onChange={(v) => set({ from: v })} />
          </span>
        </div>
        <div className="ps-stats">
          <div>
            <span className="label">Peak week</span>
            <b className="num">
              {before.peak} → {now.peak} km
            </b>
          </div>
          <div>
            <span className="label">Longest run</span>
            <b className="num">
              {before.longest} → {now.longest} km
            </b>
          </div>
          <div>
            <span className="label">Total to the last race</span>
            <b className="num">
              {Math.round(before.total)} → {Math.round(now.total)} km
            </b>
          </div>
          <div>
            <span className="label">Runs a week</span>
            <b className="num">
              {before.avgRuns.toFixed(1)} → {now.avgRuns.toFixed(1)}
            </b>
          </div>
          {shapes.map((s) => (
            <div key={s.label}>
              <span className="label">Marathon shape, {s.label}</span>
              <b className={"num " + (s.after >= 100 ? "tone-accent" : s.after < s.before ? "tone-warn" : "")}>
                {s.before}% → {s.after}%
              </b>
            </div>
          ))}
        </div>
        <BarChart bars={bars} height={compact ? 140 : 170} unit=" km" showValues={false} />
        <p className="ps-note">Bars: weekly km with your settings · marks: the plan as written.</p>
      </section>

      <div className="ps-actions">
        <button className="btn btn-primary" disabled={busy || (!changed && !plan.adjust)} onClick={() => save(a)}>
          {busy ? "Saving…" : saved ? "Saved" : changed ? "Save settings" : plan.adjust ? "Use the plan as written" : "Save settings"}
        </button>
        {plan.adjust && (
          <button className="btn" disabled={busy} onClick={() => save(null)}>
            Back to the plan as written
          </button>
        )}
        <span className="ps-note">Saved settings update the training calendar, pace on point, marathon shape, your Google Calendar and the phone.</span>
      </div>
      <ErrorNote error={err} />
    </div>
  );
}

/** How the plan is put together, worked out from the plan itself. */
export function AboutPlan({ plan }: { plan: Plan }) {
  const today = useToday();
  const info = useMemo(() => {
    let easy = 0;
    let total = 0;
    let sessions = 0;
    let weeks = 0;
    let longest = 0;
    let longs = 0;
    let medium = 0;
    for (const w of plan.weeks.filter((x) => x.start >= mondayOf(today))) {
      const f = forecastWeek(plan, w.start);
      if (!f.week) continue;
      weeks++;
      for (const d of f.days) {
        const k = d.km ?? 0;
        total += k;
        if (d.kind === "easy" || d.kind === "long" || d.kind === "optional") easy += k;
        if (d.kind === "key") sessions++;
        if (d.kind === "long") {
          longs++;
          longest = Math.max(longest, k);
        }
        if (/medium/i.test(d.text)) medium++;
      }
    }
    return { easyPct: total ? Math.round((easy / total) * 100) : 0, perWeek: weeks ? sessions / weeks : 0, longest, longs, medium, weeks };
  }, [plan, today]);
  return (
    <div className="about-plan">
      {plan.built ? (
        <p>
          This plan was <b>built in the app</b> for <b>{plan.built.raceName || "your race"}</b> on {fmt(plan.built.raceDate)}: {plan.built.weeks} weeks from {fmt(plan.built.start)}, at the{" "}
          {plan.built.level} level, {plan.built.days} days a week, starting from your fitness then (VDOT {plan.built.vdot.toFixed(1)}). It's built the way most coaches build one,
          drawing on Jack Daniels' training paces and Pete Pfitzinger's marathon blocks:
        </p>
      ) : (
        <p>
          Your plan comes from <b>{plan.source.replace(/^Claude doc: /, "your training doc, ")}</b>. It's built the way most marathon coaches build one (it draws on Jack Daniels' paces
          and Pete Pfitzinger's marathon blocks):
        </p>
      )}
      <ul className="bullets">
        <li>
          <b>Mostly easy:</b> about {info.easyPct}% of the planned distance is easy running, long runs included, so the hard days can be hard.
        </li>
        <li>
          <b>{info.perWeek.toFixed(1)} quality sessions a week:</b> threshold and VO2 max intervals early on, then marathon- and half-marathon-pace work closer to the races.
        </li>
        <li>
          <b>A long run most weeks</b>, building to {info.longest} km{info.medium ? `, plus a mid-week medium-long run in ${info.medium} weeks` : ""}.
        </li>
        <li>
          <b>Paces from your race fitness</b> (VDOT), so they move as you get fitter. An easier week every three or four weeks, and a taper before each marathon.
        </li>
      </ul>
      <h4>Phases</h4>
      <ul className="bullets">
        {plan.phases
          .filter((p) => p.summary)
          .map((p) => (
            <li key={p.name}>
              <b>{p.name.replace(/\s*\(.*\)\s*$/, "")}</b>
              {p.start && p.end ? (
                <span className="muted">
                  {" "}
                  ({fmt(p.start)} – {fmt(p.end)})
                </span>
              ) : null}
              : {p.summary}
            </li>
          ))}
      </ul>
      {plan.rules.length > 0 && (
        <>
          <h4>The plan's rules</h4>
          <ul className="bullets">
            {plan.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
