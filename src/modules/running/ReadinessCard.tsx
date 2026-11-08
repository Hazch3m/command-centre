import { useMemo } from "react";
import { addDays, useToday } from "../../core/time";
import { useFitness } from "./fitness";
import { fmtTime } from "./pbs";
import type { Plan, PlanRace } from "./plan";
import { garminTimeAt, raceReadiness, readinessTone, type Readiness, type VdotAt } from "./readiness";
import { useDataVersion } from "../../core/events";
import { useQuery } from "../../core/useQuery";
import { latestPredictions } from "../health/data";
import { useRunningData } from "./useRunning";

/** Fitness on a date and the km you ran each day: what readiness needs. */
export function useReadinessInputs(plan: Plan | undefined) {
  const f = useFitness(plan);
  const { runs = [] } = useRunningData();
  const today = useToday();
  const hv = useDataVersion("health");
  const gq = useQuery(latestPredictions, [hv]);
  const garmin = gq.data;
  const gLoading = gq.loading;
  return useMemo(() => {
    const actual = new Map<string, number>();
    for (const r of runs) actual.set(r.date, (actual.get(r.date) ?? 0) + r.distance / 1000);
    // Fitness on the day: the projection (or current form), never below your best race of the last year
    // (form estimates dip after a marathon or in an easy block; a race you've run is proof of what you can do).
    const basis = f?.predictionBasis;
    const floor = basis?.source === "race" ? basis.vdot : null;
    const vdotAt: VdotAt = (d: string) => {
      // A result you entered is your fitness, as you said.
      if (basis?.source === "manual") return basis.vdot;
      const v = f ? (f.project(d) ?? f.current) : null;
      return v == null ? floor : floor == null ? v : Math.max(v, floor);
    };
    // Garmin's race predictor, when synced in the last two weeks, sets "now" (it tracks racing well).
    if (garmin && garmin.date >= addDays(today, -14)) vdotAt.garmin = (m: number) => garminTimeAt(garmin.values, m);
    return { actual, vdotAt, ready: !!f && !(gLoading && garmin === undefined) };
  }, [f, runs, garmin, gLoading, today]);
}

export function useReadiness(plan: Plan | undefined, race: Pick<PlanRace, "date" | "name" | "km" | "target" | "elevation"> | null): Readiness | null {
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
                {r.now ? (
                  <>
                    Now <b>{fmtTime(r.now)}</b> ·{" "}
                  </>
                ) : null}
                Race day <b>{r.range ? `${fmtTime(r.range[0])}–${fmtTime(r.range[1])}` : fmtTime(r.predicted)}</b>
                {r.range ? <span className="muted"> (likely {fmtTime(r.predicted)})</span> : null}
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
