import { useMemo, useState } from "react";
import { forecastWeek, type ForecastDay, type ForecastWeek } from "../modules/running/forecast";
import { savePlanAdjust, WEEK_KEYS, type Plan } from "../modules/running/plan";
import { ADJUST_DEFAULTS, applyAdjust, withKm, type PlanAdjust } from "../modules/running/planAdjust";
import { setOverride } from "../modules/running/strava";

const DOW_NAME: Record<string, string> = { mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays" };

/** The plan without your settings, to measure "as planned" against. */
const baseOf = (plan: Plan): Plan => ({ ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined, adjust: null });

/** The plan's own longest long run: the ceiling a longer long run never goes past. */
function peakLong(plan: Plan): number {
  const b = baseOf(plan);
  return Math.max(0, ...b.weeks.map((w) => Math.max(0, ...forecastWeek(b, w.start).days.filter((d) => d.kind === "long").map((d) => d.km ?? 0))));
}

/** Take `km` off the week's other easy runs, a kilometre at a time from the biggest (none under 5 km). */
function takeFrom(days: ForecastDay[], skip: string, km: number): { date: string; text: string }[] {
  const pool = days.filter((x) => x.date !== skip && x.kind === "easy" && !x.race && (x.km ?? 0) > 5).map((x) => ({ d: x, km: x.km ?? 0 }));
  let left = km;
  while (left > 0 && pool.some((p) => p.km > 5)) {
    pool.sort((a, b) => b.km - a.km);
    pool[0].km -= 1;
    left -= 1;
  }
  return pool.filter((p) => p.km !== p.d.km).map((p) => ({ date: p.d.date, text: withKm(p.d.text, p.km, "easy") }));
}

/**
 * Make one run longer (or shorter): just this one, or this one and the same run every week after
 * (every long run, or every Tuesday's run). The extra can go on top of the week or come out of its
 * other easy runs; long runs never go past the plan's own longest.
 */
export function SessionBump({ plan, d, week, onDone }: { plan: Plan; d: ForecastDay; week: ForecastWeek; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [by, setBy] = useState(2);
  const [later, setLater] = useState(true);
  const [balance, setBalance] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const isLong = d.kind === "long";
  const i = week.days.findIndex((x) => x.date === d.date);
  const dow = WEEK_KEYS[i];
  const km = d.km ?? 0;
  const cap = useMemo(() => (isLong ? Math.max(peakLong(plan), km) : null), [plan, isLong, km]);

  const next = useMemo((): PlanAdjust => {
    const cur: PlanAdjust = plan.adjust ?? { ...ADJUST_DEFAULTS, from: week.monday };
    const from = cur.from > week.monday ? week.monday : cur.from;
    if (isLong) return { ...cur, from, longExtra: (cur.longExtra ?? 0) + by, longMax: cur.longMax ?? cap, longBalance: balance };
    return { ...cur, from, dayExtra: { ...(cur.dayExtra ?? {}), [dow]: (cur.dayExtra?.[dow] ?? 0) + by }, dayBalance: balance };
  }, [plan.adjust, week.monday, isLong, by, cap, balance, dow]);

  // What it does: this run, the week's km, and (for every week) the next few of the same run.
  const preview = useMemo(() => {
    const newKm = Math.max(3, isLong && cap ? Math.min(cap, km + by) : km + by);
    if (!later) return { runs: [{ date: d.date, from: km, to: newKm }], weekFrom: week.plannedKm ?? 0, weekTo: (week.plannedKm ?? 0) + (balance ? 0 : newKm - km) };
    const after = applyAdjust({ ...baseOf(plan), adjust: next });
    const runs: { date: string; from: number; to: number }[] = [];
    for (const w of plan.weeks.filter((x) => x.start >= week.monday).slice(0, 12)) {
      const a = forecastWeek(plan, w.start).days;
      const b = forecastWeek(after, w.start).days;
      const k = isLong ? a.findIndex((x) => x.kind === "long") : i;
      if (k < 0 || !(a[k].km ?? 0)) continue;
      const kb = isLong ? b.findIndex((x) => x.kind === "long") : k;
      runs.push({ date: a[k].date, from: a[k].km ?? 0, to: kb >= 0 ? b[kb].km ?? 0 : 0 });
    }
    const wa = forecastWeek(after, week.monday).plannedKm ?? 0;
    return { runs, weekFrom: week.plannedKm ?? 0, weekTo: wa };
  }, [later, plan, next, week, d.date, km, by, isLong, cap, i, balance]);

  const apply = async () => {
    setBusy(true);
    try {
      if (!later) {
        const newKm = Math.max(3, isLong && cap ? Math.min(cap, km + by) : km + by);
        await setOverride(d.date, withKm(d.text, newKm, isLong ? "long run" : "easy"));
        if (balance && newKm > km) for (const o of takeFrom(week.days, d.date, newKm - km)) await setOverride(o.date, o.text);
      } else await savePlanAdjust(next);
      setDone(later ? `${isLong ? "Long runs" : DOW_NAME[dow]} ${by > 0 ? "+" : "−"}${Math.abs(by)} km from this week.` : `This run is now ${km + by} km.`);
      setOpen(false);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };

  if (!km || d.race) return null;
  if (!open)
    return (
      <div className="bump-row">
        <button type="button" className="bump-open" onClick={() => (setOpen(true), setDone(null))}>
          ± Change the distance{isLong ? " of long runs" : ""}
        </button>
        {done && <span className="bump-done">{done}</span>}
      </div>
    );
  const fmtD = (x: string) => new Date(x + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <div className="bump">
      <div className="bump-line">
        <span>By</span>
        <span className="segmented small-seg">
          {[-2, -1, 1, 2, 3, 4].map((v) => (
            <button key={v} type="button" className={by === v ? "on" : ""} onClick={() => setBy(v)}>
              {v > 0 ? "+" : "−"}
              {Math.abs(v)} km
            </button>
          ))}
        </span>
      </div>
      <div className="bump-line">
        <span>Which</span>
        <span className="segmented small-seg">
          <button type="button" className={!later ? "on" : ""} onClick={() => setLater(false)}>
            Just this run
          </button>
          <button type="button" className={later ? "on" : ""} onClick={() => setLater(true)}>
            This and every {isLong ? "long run" : DOW_NAME[dow].replace(/s$/, "")} after
          </button>
        </span>
      </div>
      <div className="bump-line">
        <span>The week</span>
        <span className="segmented small-seg">
          <button type="button" className={!balance ? "on" : ""} onClick={() => setBalance(false)}>
            Add to its km
          </button>
          <button type="button" className={balance ? "on" : ""} onClick={() => setBalance(true)}>
            Keep its km (shorter easy runs)
          </button>
        </span>
      </div>
      <div className="bump-preview">
        <span>
          {preview.runs.slice(0, 8).map((r) => (
            <span key={r.date} className="bump-run">
              {fmtD(r.date)} <s>{r.from}</s> → <b>{r.to}</b>
            </span>
          ))}
          {preview.runs.length > 8 && <span className="muted">…</span>}
        </span>
        <span className="muted small">
          This week {Math.round(preview.weekFrom)} → {Math.round(preview.weekTo)} km{isLong && cap ? ` · no long run above ${cap} km (the plan's longest)` : ""}
        </span>
      </div>
      <div className="bump-actions">
        <button type="button" className="btn small" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="button" className="btn small btn-primary" onClick={apply} disabled={busy}>
          {busy ? "Saving…" : "Apply"}
        </button>
      </div>
    </div>
  );
}
