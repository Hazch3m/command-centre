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
