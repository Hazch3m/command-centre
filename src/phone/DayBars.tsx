import type { ForecastDay } from "../modules/running/forecast";
import { zoneOf } from "./EffortProfile";

const DOW = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The week as little mileage bars, a day each: the outline is what's planned, the fill what you ran.
 * Coloured by the kind of run; tap a day to open it.
 */
export function DayBars({ days, today, sel, onDay, height = 46 }: { days: ForecastDay[]; today: string; sel?: string; onDay?: (date: string) => void; height?: number }) {
  const max = Math.max(5, ...days.map((d) => Math.max(d.km ?? 0, d.actualKm)));
  return (
    <div className="db" style={{ ["--db-h" as string]: `${height}px` }} data-noswipe>
      {days.map((d, i) => {
        const t = d.race ? "race" : (d.km ?? 0) > 0 || d.runs.length ? zoneOf(d.text, d.kind) : "rest";
        const plan = d.km ?? 0;
        const done = d.actualKm;
        const missed = d.date < today && plan > 0 && !d.runs.length;
        return (
          <button
            type="button"
            key={d.date}
            className={`db-day z-${t}` + (d.date === today ? " today" : "") + (d.date === sel ? " on" : "") + (done ? " done" : "") + (missed ? " missed" : "")}
            onClick={onDay ? () => onDay(d.date) : undefined}
            aria-label={`${d.date}: ${plan ? `${plan} km planned` : "rest"}${done ? `, ${done.toFixed(1)} km run` : ""}`}
          >
            <span className="db-km num">{done ? done.toFixed(done < 10 ? 1 : 0) : plan || ""}</span>
            <span className="db-bar">
              {plan > 0 && <i className="db-plan" style={{ height: `${(plan / max) * 100}%` }} />}
              {done > 0 && <i className="db-done" style={{ height: `${(done / max) * 100}%` }} />}
            </span>
            <span className="db-dow">{DOW[i]}</span>
          </button>
        );
      })}
    </div>
  );
}
