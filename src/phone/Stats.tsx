import { useToday } from "../core/time";
import { isEmptyPlan } from "../core/account";
import { forecastRange } from "../modules/running/forecast";
import { useRunningData } from "../modules/running/useRunning";
import { FitnessPredictor, GoalCarousel } from "./PlanGoals";
import { PaceOnTrack } from "./PaceOnTrack";
import { LoadFocusCard, PlanFocusWeeks } from "./Focus";
import { TrainingLoad } from "./TrainingLoad";
import { RunalyzeMore } from "./RunalyzeMore";
import { Section } from "./common";
import { CoachCard } from "../modules/running/Coach";

/*
 * The detail pages behind Progress: each race's readiness and pace targets, and the training-load numbers
 * (fitness, fatigue and form, Garmin's load focus, zones). Progress itself answers the questions; these are
 * the working.
 */

/** Progress → Race readiness and pace targets. */
export function GoalsPage() {
  const { plan, runs = [] } = useRunningData();
  if (!plan || isEmptyPlan(plan)) return null;
  return (
    <div className="p-screen">
      <Section title="This week">
        <CoachCard plan={plan} runs={runs} />
      </Section>
      <GoalCarousel plan={plan} />
      <PaceOnTrack plan={plan} runs={runs} />
      <FitnessPredictor plan={plan} />
    </div>
  );
}

/** Progress → Training load and zones. */
export function LoadPage() {
  const today = useToday();
  const { plan } = useRunningData();
  const r = plan && !isEmptyPlan(plan) ? forecastRange(plan, today) : null;
  return (
    <div className="p-screen">
      <LoadFocusCard plan={plan} />
      {plan && r && (
        <details className="p-fold">
          <summary>Load focus in the weeks ahead</summary>
          <PlanFocusWeeks plan={plan} first={r.first} last={r.last} />
        </details>
      )}
      <TrainingLoad />
      <RunalyzeMore />
    </div>
  );
}
