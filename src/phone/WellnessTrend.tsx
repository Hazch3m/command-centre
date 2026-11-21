import { useState } from "react";
import { addDays, parseKey, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { loadHealth, type HealthDay } from "../modules/health/data";
import { rolling, summarize, windowAvg } from "../modules/health/wellness";
import { Section } from "./common";

/*
 * Resting heart rate and HRV over time, from Garmin's daily numbers: each night as a dot, the 7-day average as a
 * line, and the last 7 and 30 days' averages beside the lowest 30-day average on record. Falling resting HR and
 * rising HRV over months are what fitness looks like; a jump up in resting HR or a run of low HRV is fatigue.
 */
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANGES = [
  { id: 90, label: "3 mo" },
  { id: 180, label: "6 mo" },
  { id: 365, label: "1 yr" },
  { id: 600, label: "All" },
] as const;

export function WellnessTrend() {
  const today = useToday();
  const hv = useDataVersion("health");
  const [days, setDays] = useState<number>(90);
  // All of it (for the lowest 30-day average on record); the chart shows the chosen range.
  const rows = useQuery(() => loadHealth(800), [hv, today]).data;
  if (!rows || !rows.some((r) => r.rhr != null || r.hrv != null)) return null;
  const from = addDays(today, -(days - 1));
  const rhr = summarize(rows, "rhr", today);
  const hrv = summarize(rows, "hrv", today);
  const f0 = (x: number | null | undefined) => (x == null ? "–" : String(Math.round(x)));
  return (
    <Section title="Resting heart rate and HRV">
      <div className="wt">
        <div className="tl-tiles">
          <span className="tl-tile">
            <small>Resting HR, 7 days</small>
            <b className="num">{f0(rhr.last_7_days)}</b>
          </span>
          <span className="tl-tile">
            <small>30 days</small>
            <b className="num">{f0(rhr.last_30_days)}</b>
          </span>
          <span className="tl-tile" title={rhr.lowest_30_day_average ? `30 days to ${rhr.lowest_30_day_average.period_end}` : undefined}>
            <small>Lowest 30-day</small>
            <b className="num">{f0(rhr.lowest_30_day_average?.value)}</b>
          </span>
        </div>
        <Trend rows={rows} k="rhr" from={from} to={today} unit="bpm" cls="wt-rhr" />
        <div className="tl-tiles">
          <span className="tl-tile">
            <small>HRV, 7 days</small>
            <b className="num">{f0(hrv.last_7_days)}</b>
          </span>
          <span className="tl-tile">
            <small>30 days</small>
            <b className="num">{f0(hrv.last_30_days)}</b>
          </span>
          <span className="tl-tile" title={hrv.highest_30_day_average ? `30 days to ${hrv.highest_30_day_average.period_end}` : undefined}>
            <small>Best 30-day</small>
            <b className="num">{f0(hrv.highest_30_day_average?.value)}</b>
          </span>
        </div>
        <Trend rows={rows} k="hrv" from={from} to={today} unit="ms" cls="wt-hrv" band />
        <div className="tl-foot">
          <span className="tl-key muted">Dots: each night · line: 7-day average{" "}{rows.some((r) => r.hrv_low != null) ? "· shaded: your HRV's balanced range" : ""}</span>
          <span className="p-seg tl-range">
            {RANGES.map((r) => (
              <button key={r.id} className={days === r.id ? "on" : ""} onClick={() => setDays(r.id)}>
                {r.label}
              </button>
            ))}
          </span>
        </div>
      </div>
    </Section>
  );
}

function Trend({ rows, k, from, to, unit, cls, band }: { rows: HealthDay[]; k: "rhr" | "hrv"; from: string; to: string; unit: string; cls: string; band?: boolean }) {
  const pts = rows.filter((r) => r.date >= from && r.date <= to && typeof r[k] === "number").map((r) => ({ date: r.date, v: r[k] as number }));
  const avg = rolling(rows, k, 7, to).filter((p) => p.date >= from);
  if (pts.length < 3) return <p className="muted small">Not enough nights in this range yet.</p>;
  const W = 320;
  const H = 96;
  const n = Math.round((parseKey(to).getTime() - parseKey(from).getTime()) / 864e5);
  const bandRows = band ? rows.filter((r) => r.date >= from && r.hrv_low != null && r.hrv_high != null) : [];
  const vals = [...pts.map((p) => p.v), ...bandRows.flatMap((r) => [r.hrv_low!, r.hrv_high!])];
  const lo = Math.floor(Math.min(...vals) - 2);
  const hi = Math.ceil(Math.max(...vals) + 2);
  const x = (d: string) => ((parseKey(d).getTime() - parseKey(from).getTime()) / 864e5 / Math.max(1, n)) * W;
  const y = (v: number) => 8 + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - 16);
  const line = avg.map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)} ${y(p.value).toFixed(1)}`).join("");
  const bandPath = bandRows.length > 1 ? bandRows.map((r, i) => `${i ? "L" : "M"}${x(r.date).toFixed(1)} ${y(r.hrv_high!).toFixed(1)}`).join("") + [...bandRows].reverse().map((r) => `L${x(r.date).toFixed(1)} ${y(r.hrv_low!).toFixed(1)}`).join("") + "Z" : null;
  const months: { d: string; label: string }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (parseKey(d).getDate() === 1) months.push({ d, label: MON[parseKey(d).getMonth()] });
  const last7 = windowAvg(rows, k, to, 7);
  return (
    <svg className={`tl-chart wt-chart ${cls}`} viewBox={`0 0 ${W} ${H + 14}`} role="img" aria-label={`${k === "rhr" ? "Resting heart rate" : "HRV"}: 7-day average ${last7 == null ? "unknown" : Math.round(last7)} ${unit}`}>
      {bandPath && <path d={bandPath} className="wt-band" />}
      {[lo + 2, hi - 2].map((v) => (
        <text key={v} x={W - 2} y={y(v) - 2} textAnchor="end" className="tl-mon">
          {v} {unit}
        </text>
      ))}
      {pts.map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.v)} r={1.6} className="wt-dot" />
      ))}
      <path d={line} className="wt-line" />
      {months.map((m) => (
        <text key={m.d} x={Math.min(W - 14, x(m.d) + 2)} y={H + 12} className="tl-mon">
          {m.label}
        </text>
      ))}
    </svg>
  );
}
