import { backend } from "@backend";
import { relativeDayLabel, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { CardHeader, Empty } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { fmtVo2, useFitness } from "./fitness";
import { RouteMap } from "./route";
import { duration, km, pace } from "./stats";
import { useRunningData, useStravaSync } from "./useRunning";
import { judge } from "./vo2";

const STATUS_TEXT = { ahead: "Ahead of trend", "on-track": "On trend", behind: "Below trend", "no-data": "" } as const;

function LatestRunCard(_: CardProps) {
  const today = useToday();
  useStravaSync();
  const { plan, connected } = useRunningData();
  const f = useFitness(plan);
  const r = f?.latest;
  if (!f) return <CardHeader title="Latest run" />;
  if (!r)
    return (
      <>
        <CardHeader title="Latest run" />
        <Empty>{connected ? "No runs synced yet." : "Connect Strava in Settings to see your latest run here."}</Empty>
      </>
    );
  const time = r.start_local.slice(11, 16);
  const projected = r.estimate ? f.project(r.date) : null;
  const status = r.estimate && projected != null ? judge(r.estimate.vo2, projected) : null;
  const splits = r.detail?.splits.filter((s) => s.distance > 300) ?? [];
  return (
    <>
      <CardHeader
        title="Latest run"
        right={
          <button className="btn ghost" onClick={() => backend.openStravaActivity(r.id)} title="Open on Strava">
            Strava ↗
          </button>
        }
      />
      <div className="lr-body">
        <div className="lr-map">
          <RouteMap polyline={r.polyline} height={140} />
        </div>
        <div className="lr-stats">
          <div className="lr-title one-line" title={r.name}>
            {r.name}
          </div>
          <div className="muted small">
            {relativeDayLabel(r.date, today)} · {time}
            {r.shoe ? ` · ${r.shoe.name}` : ""}
          </div>
          <div>
            <span className="num big-ish">{km(r.distance).toFixed(2)}</span> <span className="muted">km</span>
          </div>
          <div>
            <span className="num">{duration(r.moving_time)}</span> · <span className="num">{pace(r.distance, r.moving_time)}</span>
            <span className="muted">/km</span>
          </div>
          <div>
            {r.avg_hr ? (
              <>
                <span className="num">{Math.round(r.avg_hr)}</span> <span className="muted">bpm avg</span>
                {r.max_hr ? <span className="muted"> · max {Math.round(r.max_hr)}</span> : null}
              </>
            ) : (
              <span className="muted">No heart rate</span>
            )}
          </div>
          <div className="muted">{r.elevation ? `${Math.round(r.elevation)} m climb` : ""}</div>
          {r.estimate ? (
            <div className="lr-vo2">
              <span className="label">VO2 est.</span> <span className="num">{fmtVo2(r.estimate.vo2)}</span>
              {status && <span className={`status status-${status === "behind" ? "behind" : status === "ahead" ? "on-track" : "between"}`}>{STATUS_TEXT[status]}</span>}
            </div>
          ) : (
            <div className="muted small">{r.detail ? "Not a key run (too easy or unsteady for a VO2 reading)" : r.avg_hr ? "Fetching splits…" : ""}</div>
          )}
        </div>
      </div>
      <div className="lr-splits">
          {splits.length > 1 && (
        <BarChart
          height={44}
          min={Math.max(0, Math.floor(Math.min(...splits.map((s) => s.speed * 3.6))) - 2)}
          labelEvery={splits.length > 16 ? 5 : splits.length > 8 ? 2 : 1}
          bars={splits.map((s, i) => ({
            label: String(i + 1),
            value: (s.speed * 3.6),
            highlight: !!s.hr && s.hr >= 0.85 * f.config.hrMax,
            title: `km ${i + 1}: ${pace(s.distance, s.moving_time)}/km${s.hr ? ` · ${Math.round(s.hr)} bpm` : ""}${s.elev ? ` · ${s.elev > 0 ? "+" : ""}${Math.round(s.elev)} m` : ""}`,
          }))}
        />
      )}
      </div>
    </>
  );
}

export const latestRunModule: DashboardModule = {
  id: "latest-run",
  title: "Latest run",
  defaultPos: { x: 0, y: 30, w: 6, h: 10 },
  minW: 3,
  minH: 3,
  Card: LatestRunCard,
};
