import { useMemo } from "react";
import { useToday } from "../../core/time";
import { useFitness } from "./fitness";
import { fmtTime } from "./pbs";
import type { Plan, PlanRace } from "./plan";
import { raceReadiness, readinessTone, type Readiness } from "./readiness";
import { useRunningData } from "./useRunning";

/** Fitness on a date and the km you ran each day: what readiness needs. */
export function useReadinessInputs(plan: Plan | undefined) {
  const f = useFitness(plan);
  const { runs = [] } = useRunningData();
  return useMemo(() => {
    const actual = new Map<string, number>();
    for (const r of runs) actual.set(r.date, (actual.get(r.date) ?? 0) + r.distance / 1000);
    const vdotAt = (d: string) => (f ? f.project(d) ?? f.current : null);
    return { actual, vdotAt, ready: !!f };
  }, [f, runs]);
}

export function useReadiness(plan: Plan | undefined, race: Pick<PlanRace, "date" | "name" | "km" | "target"> | null): Readiness | null {
  const today = useToday();
  const { actual, vdotAt, ready } = useReadinessInputs(plan);
  return useMemo(() => (plan && race && ready ? raceReadiness(plan, race, today, vdotAt, actual) : null), [plan, race?.date, race?.name, race?.km, race?.target, today, vdotAt, actual, ready]);
}

/** Score, the five parts as bars, and the predicted time against the goal. */
export function ReadinessView({ r, compact }: { r: Readiness; compact?: boolean }) {
  return (
    <div className={"readiness" + (compact ? " compact" : "")}>
      <div className="rd-head">
        <div className={"rd-score num " + readinessTone(r.score)}>
          {r.score}
          <small>%</small>
        </div>
        <div>
          <b>Race readiness</b>
          <div className="muted small">
            {r.predicted ? (
              <>
                Predicted <b>{fmtTime(r.predicted)}</b>
                {r.goal ? (
                  <>
                    {" "}
                    · goal {fmtTime(r.goal)}{" "}
                    <span className={r.predicted <= r.goal ? "tone-accent" : "tone-warn"}>
                      ({r.predicted <= r.goal ? "on track" : `${fmtTime(r.predicted - r.goal)} to find`})
                    </span>
                  </>
                ) : null}
              </>
            ) : (
              "No prediction yet"
            )}
          </div>
        </div>
      </div>
      <div className="rd-parts">
        {r.parts.map((p) => (
          <div key={p.key} className="rd-part" title={p.note}>
            <span className="rd-label">{p.label}</span>
            <span className="rd-bar">
              <i className={readinessTone(p.pct)} style={{ width: `${p.pct}%` }} />
            </span>
            <span className="num rd-pct">{p.pct}%</span>
            {!compact && <span className="muted small rd-note">{p.note}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
