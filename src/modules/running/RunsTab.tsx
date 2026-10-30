import { useState } from "react";
import { addDays, parseKey } from "../../core/time";
import { mondayOf } from "./plan";
import { openRun, openWeek } from "./RunView";
import { duration, km, pace } from "./stats";
import type { Run } from "./strava";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;

/** Every run, week by week (newest first), like an activity log. */
export function RunsTab({ runs }: { runs: Run[] }) {
  const [weeks, setWeeks] = useState(12);
  const newest = runs.length ? mondayOf(runs[runs.length - 1].date) : mondayOf(new Date().toISOString().slice(0, 10));
  const list = Array.from({ length: weeks }, (_, i) => addDays(newest, -7 * i));
  return (
    <div className="runs-log">
      {list.map((m) => {
        const rs = runs.filter((r) => r.date >= m && r.date <= addDays(m, 6)).reverse();
        const total = rs.reduce((s, r) => s + r.distance, 0);
        const time = rs.reduce((s, r) => s + r.moving_time, 0);
        return (
          <section key={m} className="runs-week">
            <button className="runs-week-head link" onClick={() => openWeek(m)}>
              <b>
                {fmt(m)} – {fmt(addDays(m, 6))}
              </b>
              <span className="muted small">
                {km(total).toFixed(1)} km · {rs.length} runs · {duration(time)}
              </span>
            </button>
            {rs.map((r) => (
              <button key={r.id} className="runs-row link" onClick={() => openRun(r.id)}>
                <span className="muted">
                  {DOW[parseKey(r.date).getDay()]} {parseKey(r.date).getDate()}
                </span>
                <span className="runs-name">{r.name}</span>
                <span className="num">{km(r.distance).toFixed(1)} km</span>
                <span className="num">{duration(r.moving_time)}</span>
                <span className="num">{pace(r.distance, r.moving_time)}/km</span>
                <span className="num muted">{r.avg_hr ? `${Math.round(r.avg_hr)} bpm` : ""}</span>
              </button>
            ))}
            {!rs.length && <div className="muted small runs-row">No runs</div>}
          </section>
        );
      })}
      <button className="btn" onClick={() => setWeeks((w) => w + 12)}>
        Show 12 more weeks
      </button>
    </div>
  );
}
