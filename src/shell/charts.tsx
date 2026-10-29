import { useState } from "react";

export interface Bar {
  label: string;
  value: number;
  /** Optional planned value (drawn as a tick) or range. */
  target?: number | null;
  targetMax?: number | null;
  highlight?: boolean;
  /** Tooltip text */
  title?: string;
}

/**
 * Minimal responsive bar chart in SVG: bars, optional plan ticks, a few axis
 * labels and a hover readout. Sized by its container; no external library.
 */
export function BarChart({
  bars,
  height = 120,
  unit = "",
  labelEvery = 1,
  refLine,
  min = 0,
}: {
  bars: Bar[];
  height?: number;
  unit?: string;
  labelEvery?: number;
  refLine?: { value: number; label: string } | null;
  /** Bottom of the value axis (bars start here), e.g. to zoom in on race times. */
  min?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = height;
  const pad = { top: 8, bottom: 18, left: 0, right: 0 };
  const top = Math.max(min + 1, ...bars.map((b) => Math.max(b.value, b.targetMax ?? b.target ?? 0)), refLine?.value ?? 0);
  const max = min + (top - min) * 1.08;
  const bw = (W - pad.left - pad.right) / Math.max(1, bars.length);
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - (Math.max(v, min) - min) / (max - min));
  const h = hover != null ? bars[hover] : null;
  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="img">
        {refLine && <line x1={0} x2={W} y1={y(refLine.value)} y2={y(refLine.value)} className="chart-ref" />}
        {bars.map((b, i) => {
          const x = pad.left + i * bw;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={pad.top} width={bw} height={H - pad.top - pad.bottom} fill="transparent" />
              {b.targetMax != null && b.target != null && b.targetMax > b.target && (
                <rect x={x + bw * 0.1} y={y(b.targetMax)} width={bw * 0.8} height={y(b.target) - y(b.targetMax)} className="chart-band" />
              )}
              <rect
                x={x + bw * 0.18}
                y={y(b.value)}
                width={bw * 0.64}
                height={Math.max(0, H - pad.bottom - y(b.value))}
                rx={Math.min(4, bw * 0.15)}
                className={"chart-bar" + (b.highlight ? " hl" : "") + (hover === i ? " hover" : "")}
              />
              {b.target != null && <line x1={x + bw * 0.1} x2={x + bw * 0.9} y1={y(b.target)} y2={y(b.target)} className="chart-target" />}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - 4} className="chart-label" textAnchor="middle">
                  {b.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-readout small">
        {h ? (h.title ?? `${h.label}: ${Math.round(h.value)}${unit}${h.target != null ? ` (plan ${Math.round(h.target)}${h.targetMax && h.targetMax !== h.target ? `–${Math.round(h.targetMax)}` : ""}${unit})` : ""}`) : refLine ? `– – ${refLine.label}` : " "}
      </div>
    </div>
  );
}

export interface LineSeries {
  name: string;
  points: { x: string; y: number | null; label?: string }[]; // x = YYYY-MM-DD
  kind: "line" | "dashed" | "dots" | "diamonds" | "area";
  className: string; // colour via CSS (chart-s-*)
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayNum = (d: string) => Date.parse(d + "T12:00:00Z") / 86400000;

/**
 * Time-series chart: lines, dashed projections, dots and markers on a date
 * axis, with month labels, optional vertical markers and a hover readout.
 */
export function LineChart({
  series,
  from,
  to,
  height = 160,
  yMin,
  yMax,
  markers = [],
  today,
  unit = "",
  digits = 1,
}: {
  series: LineSeries[];
  from: string;
  to: string;
  height?: number;
  yMin?: number;
  yMax?: number;
  markers?: { x: string; label: string }[];
  today?: string;
  unit?: string;
  digits?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 1000;
  const H = height;
  const pad = { top: 14, bottom: 20, left: 34, right: 8 };
  const x0 = dayNum(from);
  const x1 = dayNum(to);
  const ys = series.flatMap((s) => s.points.map((p) => p.y)).filter((y): y is number => y != null && isFinite(y));
  let lo = yMin ?? (ys.length ? Math.min(...ys) : 0);
  let hi = yMax ?? (ys.length ? Math.max(...ys) : 1);
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const span = hi - lo;
  if (yMin == null) lo -= span * 0.08;
  if (yMax == null) hi += span * 0.08;
  const X = (d: string) => pad.left + ((dayNum(d) - x0) / (x1 - x0)) * (W - pad.left - pad.right);
  const Y = (v: number) => pad.top + (1 - (v - lo) / (hi - lo)) * (H - pad.top - pad.bottom);

  // Month ticks
  const ticks: { x: number; label: string }[] = [];
  const s = new Date(from + "T12:00:00Z");
  const totalMonths = Math.round((x1 - x0) / 30);
  const every = totalMonths > 18 ? 3 : totalMonths > 9 ? 2 : 1;
  for (let d = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)); dayNum(d.toISOString().slice(0, 10)) <= x1; d.setUTCMonth(d.getUTCMonth() + every)) {
    const k = d.toISOString().slice(0, 10);
    ticks.push({ x: X(k), label: d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MON[d.getUTCMonth()] });
  }
  const yTicks = [lo, (lo + hi) / 2, hi].map((v) => Math.round(v));

  const path = (pts: { x: string; y: number | null }[]) => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      if (p.y == null) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  // Hover: nearest date column across all series.
  const allX = [...new Set(series.flatMap((s) => s.points.filter((p) => p.y != null).map((p) => p.x)))].sort();
  const hx = hover != null ? allX[hover] : null;
  const readout = hx
    ? series
        .map((s) => {
          const p = s.points.find((q) => q.x === hx && q.y != null);
          return p ? `${p.label ?? s.name} ${p.y!.toFixed(digits)}${unit}` : null;
        })
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        preserveAspectRatio="none"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = -1;
          let bd = Infinity;
          allX.forEach((x, i) => {
            const dd = Math.abs(X(x) - px);
            if (dd < bd) {
              bd = dd;
              best = i;
            }
          });
          setHover(best >= 0 && bd < 40 ? best : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={W - pad.right} y1={Y(v)} y2={Y(v)} className="chart-grid" />
            <text x={pad.left - 6} y={Y(v) + 4} className="chart-label" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t.x} x={t.x} y={H - 4} className="chart-label" textAnchor="middle">
            {t.label}
          </text>
        ))}
        {today && today >= from && today <= to && <line x1={X(today)} x2={X(today)} y1={pad.top} y2={H - pad.bottom} className="chart-today" />}
        {markers
          .filter((m) => m.x >= from && m.x <= to)
          .map((m) => (
            <g key={m.x}>
              <line x1={X(m.x)} x2={X(m.x)} y1={pad.top} y2={H - pad.bottom} className="chart-marker" />
              <text x={X(m.x) - 4} y={pad.top + 2} className="chart-label chart-marker-label" textAnchor="end">
                {m.label}
              </text>
            </g>
          ))}
        {series.map((s) => {
          const pts = s.points.filter((p) => p.y != null && p.x >= from && p.x <= to);
          if (s.kind === "line" || s.kind === "dashed")
            return <path key={s.name} d={path(s.points.filter((p) => p.x >= from && p.x <= to))} className={`chart-line ${s.kind} ${s.className}`} />;
          if (s.kind === "area") {
            const d = path(pts);
            return d ? <path key={s.name} d={`${d}L${X(pts[pts.length - 1].x)},${H - pad.bottom}L${X(pts[0].x)},${H - pad.bottom}Z`} className={`chart-area ${s.className}`} /> : null;
          }
          return (
            <g key={s.name} className={s.className}>
              {pts.map((p) =>
                s.kind === "dots" ? (
                  <circle key={p.x} cx={X(p.x)} cy={Y(p.y!)} r={5} className="chart-dot" />
                ) : (
                  <rect key={p.x} x={X(p.x) - 6} y={Y(p.y!) - 6} width={12} height={12} transform={`rotate(45 ${X(p.x)} ${Y(p.y!)})`} className="chart-diamond" />
                ),
              )}
            </g>
          );
        })}
        {hx && <line x1={X(hx)} x2={X(hx)} y1={pad.top} y2={H - pad.bottom} className="chart-hover" />}
      </svg>
      <div className="chart-readout small">{readout ? `${hx}: ${readout}` : " "}</div>
    </div>
  );
}
