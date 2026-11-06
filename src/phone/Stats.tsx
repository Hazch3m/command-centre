import { useToday } from "../core/time";
import { ModulePage } from "../shell/Dashboard";
import { Section, usePhoneNav, useReadiness } from "./common";

/** Stats, Runalyze and Garmin style: fitness, fatigue, predictions and health in one place. */
export function Stats() {
  const nav = usePhoneNav();
  const today = useToday();
  const ready = useReadiness(today);
  return (
    <div className="p-screen">
      <Section>
        <button className="p-row p-row-btn" onClick={() => nav.push("health")}>
          <span className="p-row-main">
            <span className="p-row-title">Health</span>
            <span className="p-row-sub">{ready ? `Readiness ${ready.score}${ready.level ? ` · ${ready.level}` : ""}${ready.hrv ? ` · HRV ${Math.round(ready.hrv)}` : ""}` : "Readiness, HRV, sleep, resting heart rate"}</span>
          </span>
          <span className="p-chev">›</span>
        </button>
        <button className="p-row p-row-btn" onClick={() => nav.push("plan")}>
          <span className="p-row-main">
            <span className="p-row-title">Pace on point and race progress</span>
            <span className="p-row-sub">How well runs hit their targets, benchmarks, race history</span>
          </span>
          <span className="p-chev">›</span>
        </button>
      </Section>
      <div className="p-embed">
        <ModulePage id="fitness" />
      </div>
    </div>
  );
}
