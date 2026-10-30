import { CardHeader, Empty } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { useFitness } from "./fitness";
import { duration } from "./stats";
import { useRunningData } from "./useRunning";

/** "−0:23" faster (green), "+0:10" slower (red), against a month ago. */
export function Delta({ now, then }: { now: number | null; then: number | null }) {
  if (now == null || then == null) return <span className="muted">–</span>;
  const d = Math.round(now - then);
  if (Math.abs(d) < 1) return <span className="muted">±0</span>;
  return (
    <span className={d < 0 ? "tone-accent" : "tone-danger"} title={d < 0 ? "Faster than a month ago" : "Slower than a month ago"}>
      {d < 0 ? "−" : "+"}
      {duration(Math.abs(d))}
    </span>
  );
}

/** A thin bar for the marathon shape, with the 100 % a marathon needs marked. */
export function ShapeBar({ value, label = true }: { value: number; label?: boolean }) {
  const pct = Math.round(value * 100);
  return (
    <div className="shape-bar" title={`Marathon shape ${pct}%: a marathon needs 100%, a half 43%, a 10k 17%`}>
      {label && (
        <span className="label">
          Marathon shape <b className="num">{pct}%</b>
        </span>
      )}
      <span className="shape-track">
        <span className={"shape-fill" + (value >= 1 ? " full" : value >= 0.7 ? " mid" : "")} style={{ width: `${Math.min(100, pct / 1.2)}%` }} />
        <i style={{ left: `${(0.43 * 100) / 1.2}%` }} title="Half marathon needs 43%" />
        <i style={{ left: `${100 / 1.2}%` }} title="Marathon needs 100%" />
      </span>
    </div>
  );
}

function PredictionsCard({ editing }: CardProps) {
  const { plan } = useRunningData();
  const f = useFitness(plan);
  const garmin = !!f?.predictions.some((p) => p.source === "garmin");
  return (
    <>
      <CardHeader title="Race predictions" to={editing ? undefined : "fitness"} right={<span className="muted small">{garmin ? "Garmin · " : ""}change in 30 days</span>} />
      {!f ? null : !f.predictions.some((p) => p.seconds) ? (
        <Empty>Predictions appear once you have a race or a few key runs.</Empty>
      ) : (
        <>
          <table className="pred-table">
            <thead>
              <tr>
                <th />
                <th className="num-col">Now</th>
                <th className="num-col">30 d</th>
                <th className="num-col">Target</th>
                <th className="num-col pred-gap">To go</th>
              </tr>
            </thead>
            <tbody>
              {f.predictions.map((p) => (
                <tr key={p.name}>
                  <th>{p.name}</th>
                  <td className="num-col num">
                    <b className={p.targetSeconds && p.seconds && p.seconds <= p.targetSeconds ? "tone-accent" : ""}>{p.seconds ? duration(p.seconds) : "–"}</b>
                  </td>
                  <td className="num-col num small">
                    <Delta now={p.seconds} then={p.secondsMonthAgo} />
                  </td>
                  <td className="num-col num small muted" title={p.target ?? undefined}>
                    {p.targetSeconds ? duration(p.targetSeconds) : "–"}
                  </td>
                  <td className="num-col num small pred-gap">
                    {p.targetSeconds && p.seconds ? (
                      p.seconds <= p.targetSeconds ? (
                        <span className="tone-accent">✓</span>
                      ) : (
                        <span className="muted">{duration(p.seconds - p.targetSeconds)}</span>
                      )
                    ) : (
                      ""
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.shape && <ShapeBar value={f.shape.total} />}
        </>
      )}
    </>
  );
}

export const predictionsModule: DashboardModule = {
  id: "predictions",
  title: "Race predictions",
  defaultPos: { x: 0, y: 0, w: 6, h: 5 },
  minW: 3,
  minH: 3,
  Card: PredictionsCard,
};
