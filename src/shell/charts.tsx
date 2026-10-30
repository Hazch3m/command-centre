import { useLayoutEffect, useRef, useState } from "react";

/**
 * The chart's real size in pixels, so drawing is never stretched (text stays
 * crisp at any tile size). With height "fill" the chart takes the space its
 * container gives it.
 */
export function useBox(fill: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Inner size: the frame's padding isn't drawing space.
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const py = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      setBox({ w: Math.max(0, Math.round(el.clientWidth - px)), h: Math.max(0, Math.round(el.clientHeight - py)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);
  return [ref, box] as const;
}
const READOUT = 20;

export interface Bar {
  label: string;
  value: number;
  /** Optional planned value (drawn as a tick) or range. */
  target?: number | null;
  targetMax?: number | null;
  highlight?: boolean;
  /** Not run yet: drawn faint (planned weeks). */
  planned?: boolean;
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
  showValues = true,
  digits = 0,
  onBar,
}: {
  /** Makes bars clickable. */
  onBar?: (index: number) => void;
  bars: Bar[];
  /** Write each bar's value above it (when there's room). */
  showValues?: boolean;
  digits?: number;
  height?: number | "fill";
  unit?: string;
  labelEvery?: number;
  refLine?: { value: number; label: string } | null;
  /** Bottom of the value axis (bars start here), e.g. to zoom in on race times. */
  min?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const fill = height === "fill";
  const [ref, box] = useBox(fill);
  const W = box.w || 1000;
  const H = fill ? Math.max(40, box.h - READOUT) : height;
  const pad = { top: showValues ? 16 : 8, bottom: 18, left: 0, right: 0 };
  const top = Math.max(min + 1, ...bars.map((b) => Math.max(b.value, b.targetMax ?? b.target ?? 0)), refLine?.value ?? 0);
  const max = min + (top - min) * 1.08;
  const bw = (W - pad.left - pad.right) / Math.max(1, bars.length);
  const y = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - (Math.max(v, min) - min) / (max - min));
  const h = hover != null ? bars[hover] : null;
  return (
    <div className={"chart" + (fill ? " chart-fill" : "")} ref={ref} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img">
        {refLine && <line x1={0} x2={W} y1={y(refLine.value)} y2={y(refLine.value)} className="chart-ref" />}
        {refLine && refLine.label.length * 6.2 < W * 0.55 && (
          <text x={W - 4} y={y(refLine.value) - 5} textAnchor="end" className="chart-ref-label">
            {refLine.label}
          </text>
        )}
        {bars.map((b, i) => {
          const x = pad.left + i * bw;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onClick={onBar ? () => onBar(i) : undefined} style={onBar ? { cursor: "pointer" } : undefined}>
              <rect x={x} y={pad.top} width={bw} height={H - pad.top - pad.bottom} fill="transparent" />
              {b.targetMax != null && b.target != null && b.targetMax > b.target && (
                <rect x={x + bw * 0.1} y={y(b.targetMax)} width={bw * 0.8} height={y(b.target) - y(b.targetMax)} className="chart-band" />
              )}
              <rect
                x={x + bw * 0.18}
                y={y(b.value)}
                width={bw * 0.64}
                height={Math.max(0, H - pad.bottom - y(b.value))}
                rx={Math.min(3, bw * 0.15)}
                className={"chart-bar" + (b.highlight ? " hl" : "") + (b.planned ? " planned" : "") + (hover === i ? " hover" : "")}
                style={{ animationDelay: `${Math.min(i, 40) * 18}ms` }}
              />
              {b.target != null && <line x1={x + bw * 0.1} x2={x + bw * 0.9} y1={y(b.target)} y2={y(b.target)} className="chart-target" />}
              {showValues && bw >= 22 && b.value > min && (
                <text x={x + bw / 2} y={Math.min(y(b.value), b.targetMax != null ? y(b.targetMax) : Infinity) - 4} className={"chart-value" + (b.highlight ? " hl" : "")} textAnchor="middle">
                  {b.value.toFixed(digits)}
                </text>
              )}
              {i % Math.max(labelEvery, Math.ceil(24 / bw)) === 0 && (
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
  format,
}: {
  series: LineSeries[];
  from: string;
  to: string;
  height?: number | "fill";
  yMin?: number;
  yMax?: number;
  markers?: { x: string; label: string }[];
  today?: string;
  unit?: string;
  digits?: number;
  /** Formats values on the axis and in the readout (e.g. seconds as h:mm). */
  format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const fill = height === "fill";
  const [ref, box] = useBox(fill);
  const W = box.w || 1000;
  const H = fill ? Math.max(50, box.h - READOUT) : height;
  const pad = { top: 14, bottom: 20, left: format ? 46 : 34, right: 8 };
  const fmt = format ?? ((v: number) => v.toFixed(digits));
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
  const yTicks = format ? [lo + (hi - lo) * 0.08, (lo + hi) / 2, hi - (hi - lo) * 0.08] : [...new Set([lo, (lo + hi) / 2, hi].map((v) => Math.round(v)))];

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
          return p ? `${p.label ?? s.name} ${fmt(p.y!)}${unit}` : null;
        })
        .filter(Boolean)
        .join(" · ")
    : null;

  return (
    <div className={"chart" + (fill ? " chart-fill" : "")} ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
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
              {format ? format(v) : v}
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
            return <path key={s.name} d={path(s.points.filter((p) => p.x >= from && p.x <= to))} className={`chart-line ${s.kind} ${s.className}`} pathLength={s.kind === "line" ? 1 : undefined} />;
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
      <div className="chart-readout small">{readout ? `${hx}: ${readout}` : <Legend series={series} />}</div>
    </div>
  );
}

/**
 * A line over a numeric x axis (e.g. distance in km), for a run's pace, heart
 * rate or elevation. `invert` puts lower values at the top (faster pace).
 */
export function XYChart({
  points,
  height = 110,
  invert = false,
  format = (v: number) => v.toFixed(0),
  xUnit = "km",
  className = "s-trend",
  area = false,
  label,
  marks = [],
}: {
  points: [number, number][];
  height?: number;
  invert?: boolean;
  format?: (v: number) => string;
  xUnit?: string;
  className?: string;
  area?: boolean;
  label: string;
  /** Vertical lines, e.g. lap boundaries. */
  marks?: number[];
}) {
  const [ref, box] = useBox(false);
  const [hover, setHover] = useState<number | null>(null);
  const W = box.w || 1000;
  const H = height;
  const pad = { top: 8, bottom: 16, left: 46, right: 6 };
  if (points.length < 2) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]).filter((y) => Number.isFinite(y));
  const x0 = xs[0];
  const x1 = xs[xs.length - 1] || 1;
  // Trim outliers (GPS glitches) for the y range.
  const sorted = [...ys].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  const span = hi - lo || 1;
  const X = (x: number) => pad.left + ((x - x0) / (x1 - x0 || 1)) * (W - pad.left - pad.right);
  const Y = (y: number) => {
    const t = (Math.min(hi, Math.max(lo, y)) - lo) / span;
    return pad.top + (invert ? t : 1 - t) * (H - pad.top - pad.bottom);
  };
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  const hp = hover != null ? points[hover] : null;
  const ticks = [lo, (lo + hi) / 2, hi];
  return (
    <div className="chart xy" ref={ref}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const xv = x0 + (((e.clientX - r.left) / r.width) * W - pad.left) / (W - pad.left - pad.right) * (x1 - x0);
          let best = 0;
          for (let i = 0; i < points.length; i++) if (Math.abs(points[i][0] - xv) < Math.abs(points[best][0] - xv)) best = i;
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={pad.left} x2={W - pad.right} y1={Y(v)} y2={Y(v)} className="chart-grid" />
            <text x={pad.left - 6} y={Y(v) + 4} className="chart-label" textAnchor="end">
              {format(v)}
            </text>
          </g>
        ))}
        {marks.map((m) => (
          <line key={m} x1={X(m)} x2={X(m)} y1={pad.top} y2={H - pad.bottom} className="chart-marker" />
        ))}
        {area && <path d={`${d}L${X(x1)},${H - pad.bottom}L${X(x0)},${H - pad.bottom}Z`} className={`chart-area ${className}`} />}
        <path d={d} className={`chart-line ${className}`} />
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={X(x0 + (x1 - x0) * f)} y={H - 3} className="chart-label" textAnchor={f === 1 ? "end" : "middle"}>
            {(x0 + (x1 - x0) * f).toFixed(1)}
          </text>
        ))}
        {hp && <line x1={X(hp[0])} x2={X(hp[0])} y1={pad.top} y2={H - pad.bottom} className="chart-hover" />}
      </svg>
      <div className="chart-readout small">
        <b>{label}</b> {hp ? `${format(hp[1])} at ${hp[0].toFixed(2)} ${xUnit}` : ""}
      </div>
    </div>
  );
}

/** What each line is: a small sample of its stroke, then its name. */
function Legend({ series }: { series: LineSeries[] }) {
  return (
    <span className="chart-legend">
      {series.map((s) => (
        <span key={s.name}>
          <svg width="20" height="10" aria-hidden="true">
            {s.kind === "diamonds" ? (
              <g className={s.className}>
                <rect x="6" y="1" width="8" height="8" transform="rotate(45 10 5)" className="chart-diamond" />
              </g>
            ) : s.kind === "dots" ? (
              <g className={s.className}>
                <circle cx="10" cy="5" r="4" className="chart-dot" />
              </g>
            ) : s.kind === "area" ? (
              <rect x="1" y="1" width="18" height="8" className={`chart-area ${s.className}`} />
            ) : (
              <line x1="1" x2="19" y1="5" y2="5" className={`chart-line ${s.kind} ${s.className}`} />
            )}
          </svg>
          {s.name}
        </span>
      ))}
    </span>
  );
}
