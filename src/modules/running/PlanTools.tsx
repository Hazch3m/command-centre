import { useMemo, useState } from "react";
import { useDataVersion } from "../../core/events";
import { useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { useFitness } from "./fitness";
import { loadPlanFile, savePlan, type Plan } from "./plan";
import { summarizeHistory } from "./planBuilder";
import { planText, refreshPlan } from "./planRefresh";
import { loadOverrides } from "./strava";
import { useRunningData } from "./useRunning";

/** Hands a file to the browser to save. */
function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

/**
 * Edit plan → Refresh: move the paces to your fitness now and/or swap in the current speed workouts,
 * keeping every week, long run, race and change. And export the plan to read or share.
 */
export function PlanTools({ plan }: { plan: Plan }) {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const f = useFitness(plan);
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const [paces, setPaces] = useState(true);
  const [workouts, setWorkouts] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const vNow = f ? (f.predictionBasis?.vdot ?? f.current ?? null) : null;
  const vOld = plan.built?.vdot ?? null;
  const preview = useMemo(() => {
    const raw: Plan = { ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined };
    return refreshPlan(raw, { paces, workouts }, vNow, summarizeHistory(runs, today, vNow), today);
  }, [plan, paces, workouts, vNow, runs, today]);

  const apply = async () => {
    setBusy(true);
    try {
      const { plan: raw } = await loadPlanFile();
      const r = refreshPlan(raw, { paces, workouts }, vNow, summarizeHistory(runs, today, vNow), today);
      await savePlan(r.plan);
      setDone(`Updated: ${r.swapped} workouts swapped, ${r.paced} sessions re-paced. "Bring back the previous plan" undoes it.`);
    } finally {
      setBusy(false);
    }
  };
  const slug = plan.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 40);
  return (
    <section className="plan-tools">
      <div className="pt-block">
        <h3>Refresh the plan</h3>
        <p className="muted small">Keeps every week, mileage, long run, race and change you've made; only the future weeks (from next Monday) change.</p>
        <label className="pt-check">
          <input type="checkbox" checked={paces} onChange={(e) => setPaces(e.target.checked)} disabled={!vNow || !vOld} />
          Paces to my fitness now
          <small className="muted">{vOld && vNow ? ` · built at VDOT ${vOld.toFixed(1)}, now ${vNow.toFixed(1)}` : " · needs a plan built in the app"}</small>
        </label>
        <label className="pt-check">
          <input type="checkbox" checked={workouts} onChange={(e) => setWorkouts(e.target.checked)} disabled={!plan.built} />
          New speed workouts (marathon-style), same days
        </label>
        {preview.examples.length > 0 && (
          <ul className="pt-examples">
            {preview.examples.map((x) => (
              <li key={x.date}>
                <b>{new Date(x.date + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</b> <s>{x.from}</s> → {x.to}
              </li>
            ))}
          </ul>
        )}
        <div className="pt-actions">
          <span className="muted small">
            {preview.swapped} workouts swapped · {preview.paced} sessions re-paced
          </span>
          <button type="button" className="btn btn-primary small" onClick={apply} disabled={busy || (!preview.swapped && !preview.paced)}>
            {busy ? "Saving…" : "Refresh"}
          </button>
        </div>
        {done && <p className="small tone-accent">{done}</p>}
      </div>
      <div className="pt-block">
        <h3>Export</h3>
        <p className="muted small">The whole plan week by week, with your changes: to read, print or send.</p>
        <div className="pt-actions">
          <button type="button" className="btn small" onClick={() => download(`${slug}.txt`, planText(plan, overrides), "text/plain")}>
            Download as text
          </button>
          <button type="button" className="btn small" onClick={() => download(`${slug}.json`, JSON.stringify({ ...plan, baseWeeks: undefined, previous: undefined }, null, 2), "application/json")}>
            Download as JSON
          </button>
          <button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(planText(plan, overrides)).then(() => setDone("Plan copied: paste it anywhere."))}>
            Copy
          </button>
        </div>
      </div>
    </section>
  );
}
