import { useMemo, useState } from "react";
import { mondayOf, savePlan, firstChangeableMonday, type Plan } from "../modules/running/plan";
import { useFitness } from "../modules/running/fitness";
import { summarizeHistory } from "../modules/running/planBuilder";
import { reasonsKey, replan, replanDiff, replanReasons } from "../modules/running/replan";
import { useRunningData } from "../modules/running/useRunning";
import { useToday } from "../core/time";

/*
 * Monday re-plan, suggest and confirm (spec step 7). Shows only when something has moved enough to matter:
 * says why, shows the next weeks before and after, and changes nothing until you tap "Re-plan". "Not now" hides
 * it until something new comes up.
 */
const KEY = "pacelife.replan.dismissed";
const readDismissed = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

export function ReplanCard() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vNow = f ? (f.predictionBasis?.vdot ?? f.current ?? null) : null;

  const weekKm = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) if (/run/i.test(r.sport)) m.set(mondayOf(r.date), (m.get(mondayOf(r.date)) ?? 0) + r.distance / 1000);
    return m;
  }, [runs]);
  const raw: Plan | null = plan ? { ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined } : null;
  const reasons = useMemo(() => (raw ? replanReasons(raw, { today, vdotNow: vNow, weekKm }) : []), [raw?.weeks, raw?.races, today, vNow, weekKm]);
  const key = reasonsKey(reasons, today);
  const next = useMemo(() => {
    if (!open || !raw || !reasons.length) return null;
    try {
      return replan(raw, reasons, { today, vdotNow: vNow, weekKm, history: summarizeHistory(runs, today, vNow) });
    } catch {
      return null;
    }
  }, [open, raw?.weeks, reasons, today, vNow, weekKm, runs]);
  if (!raw || !reasons.length || dismissed === key) return null;

  const diff = next ? replanDiff(raw, next, today) : [];
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, key);
    } catch {
      /* the card just comes back next time */
    }
    setDismissed(key);
  };
  const confirm = async () => {
    if (!next) return;
    setBusy(true);
    setErr(null);
    try {
      await savePlan(next);
      dismiss();
    } catch (e) {
      setErr(`Couldn't save the new plan: ${e instanceof Error ? e.message : String(e)}. Your plan hasn't changed.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="p-start p-replan" aria-label="Re-plan suggestion">
      <h2>Re-plan from {fmt(firstChangeableMonday(today))}?</h2>
      <ul className="p-replan-why">
        {reasons.map((r) => (
          <li key={r.text}>{r.text}</li>
        ))}
      </ul>
      {open && (
        <>
          {next ? (
            <table className="p-replan-diff num">
              <thead>
                <tr>
                  <th>Week of</th>
                  <th>Now</th>
                  <th>Re-planned</th>
                </tr>
              </thead>
              <tbody>
                {diff.map((d) => (
                  <tr key={d.start}>
                    <td>{fmt(d.start)}</td>
                    <td>{d.from ?? "–"} km</td>
                    <td>
                      {d.to ?? "–"} km{d.changed ? <span className="muted"> · {d.changed} {d.changed === 1 ? "day" : "days"} change</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="p-start-note">Couldn't work out the new weeks. Your plan hasn't changed.</p>
          )}
          <p className="p-start-note">The weeks you've done stay as they are, and so does your week count. Undo brings the old plan back.</p>
        </>
      )}
      {err && <p className="p-start-note">{err}</p>}
      <div className="p-start-pills">
        {open ? (
          <button className="p-pill" disabled={busy || !next} onClick={() => void confirm()}>
            {busy ? "Re-planning…" : "Re-plan"}
          </button>
        ) : (
          <button className="p-pill" onClick={() => setOpen(true)}>
            See the changes
          </button>
        )}
        <button className="p-pill p-pill-quiet" onClick={dismiss}>
          Not now
        </button>
      </div>
    </section>
  );
}
