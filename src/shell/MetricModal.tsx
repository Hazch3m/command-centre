import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { addDays, useToday } from "../core/time";
import { LineChart, type LineSeries } from "./charts";

const RANGES = [
  { days: 30, label: "1 month" },
  { days: 91, label: "3 months" },
  { days: 182, label: "6 months" },
  { days: 365, label: "1 year" },
  { days: 730, label: "2 years" },
];

/**
 * A chart of one measure in a pop-up, with a choice of how far back to look.
 * `series` should hold everything available; the range only changes the view.
 */
export function MetricModal({
  title,
  series,
  unit,
  format,
  digits,
  note,
  initialDays = 91,
  onClose,
}: {
  title: string;
  series: LineSeries[];
  unit?: string;
  format?: (v: number) => string;
  digits?: number;
  note?: ReactNode;
  initialDays?: number;
  onClose: () => void;
}) {
  const today = useToday();
  const [days, setDays] = useState(initialDays);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const from = addDays(today, -days);
  const inRange = series.map((s) => ({ ...s, points: s.points.filter((p) => p.x >= from) }));
  const vals = inRange.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y != null));
  const stats = vals.length
    ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) }
    : null;
  const show = format ?? ((v: number) => v.toFixed(digits ?? 0));
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal metric-modal" role="dialog" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <span className="segmented small-seg">
            {RANGES.map((r) => (
              <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
                {r.label}
              </button>
            ))}
          </span>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {stats && (
          <div className="metric-stats small">
            <span>
              Average <b className="num">{show(stats.avg)}</b>
              {unit}
            </span>
            <span>
              Low <b className="num">{show(stats.min)}</b>
              {unit}
            </span>
            <span>
              High <b className="num">{show(stats.max)}</b>
              {unit}
            </span>
          </div>
        )}
        <LineChart series={inRange} from={from} to={today} height={300} today={today} unit={unit} digits={digits} format={format} />
        {note && <div className="muted small">{note}</div>}
      </div>
    </div>,
    document.body,
  );
}
