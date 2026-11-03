import { useState } from "react";
import { PlanBuilder } from "../modules/running/BuildPlan";
import { ImportPlan } from "../modules/running/ImportPlan";
import { AboutPlan, PlanSettings } from "../modules/running/PlanSettings";
import { RaceManager } from "../modules/running/RaceManager";
import { useRunningData } from "../modules/running/useRunning";

const VIEWS = [
  { id: "build", label: "Build" },
  { id: "races", label: "Races" },
  { id: "import", label: "Import" },
  { id: "adjust", label: "Adjust" },
  { id: "about", label: "About" },
] as const;

/** Training → More → Your plan: build a new plan, adjust this one, or read how it's put together. */
export function PlanAdjustPage() {
  const { plan } = useRunningData();
  const [view, setView] = useState<(typeof VIEWS)[number]["id"]>("build");
  if (!plan) return <p className="p-empty">The plan hasn't arrived from the PC yet.</p>;
  return (
    <div className="p-adjust">
      <div className="p-seg" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      {view === "build" && <PlanBuilder plan={plan} compact />}
      {view === "races" && <RaceManager plan={plan} />}
      {view === "import" && <ImportPlan plan={plan} compact />}
      {view === "adjust" && <PlanSettings plan={plan} compact />}
      {view === "about" && <AboutPlan plan={plan} />}
    </div>
  );
}
