import { AboutPlan, PlanSettings } from "../modules/running/PlanSettings";
import { useRunningData } from "../modules/running/useRunning";

/** Training → More → Adjust plan: the plan settings and how the plan is built. */
export function PlanAdjustPage() {
  const { plan } = useRunningData();
  if (!plan) return <p className="p-empty">The plan hasn't arrived from the PC yet.</p>;
  return (
    <div className="p-adjust">
      <PlanSettings plan={plan} compact />
      <details className="fold p-about">
        <summary>About this plan</summary>
        <AboutPlan plan={plan} />
      </details>
    </div>
  );
}
