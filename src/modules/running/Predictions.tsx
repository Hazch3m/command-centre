import { CardHeader, Empty } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { useFitness } from "./fitness";
import { duration } from "./stats";
import { useRunningData } from "./useRunning";

/** "−0:23" faster (green), "+0:10" slower (red), against a month ago. */
function Delta({ now, then }: { now: number | null; then: number | null }) {
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

function PredictionsCard({ editing }: CardProps) {
  const { plan } = useRunningData();
  const f = useFitness(plan);
  const garmin = !!f?.predictions.some((p) => p.garminSeconds);
  return (
    <>
      <CardHeader title="Race predictions" to={editing ? undefined : "fitness"} right={<span className="muted small">change in 30 days</span>} />
      {!f ? null : !f.predictions.some((p) => p.seconds) ? (
        <Empty>Predictions appear once you have a race or a few key runs.</Empty>
      ) : (
        <table className="pred-table">
          <thead>
            <tr>
              <th />
              <th className="num-col">Yours</th>
              <th className="num-col">30 d</th>
              {garmin && <th className="num-col">Garmin</th>}
              {garmin && <th className="num-col">30 d</th>}
              <th className="num-col pred-target">Target</th>
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
                  <Delta now={p.seconds} then={p.monthAgoSeconds} />
                </td>
                {garmin && <td className="num-col num">{p.garminSeconds ? duration(p.garminSeconds) : "–"}</td>}
                {garmin && (
                  <td className="num-col num small">
                    <Delta now={p.garminSeconds} then={p.garminMonthAgo} />
                  </td>
                )}
                <td className="num-col num small muted pred-target" title={p.target ?? undefined}>
                  {p.targetSeconds ? duration(p.targetSeconds) : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
