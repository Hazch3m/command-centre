/** Google encoded polyline → [lat, lng] pairs (the format Strava uses for maps). */
export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < str.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

/** The route as a line, scaled to fit, with start (green) and finish (red) dots. No map tiles needed. */
export function RouteMap({ polyline, height = 150 }: { polyline: string | null; height?: number }) {
  if (!polyline) return <div className="route-empty muted small">No map for this run</div>;
  const pts = decodePolyline(polyline);
  if (pts.length < 2) return <div className="route-empty muted small">No map for this run</div>;
  const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const k = Math.cos((lat0 * Math.PI) / 180);
  const xy = pts.map(([la, ln]) => [ln * k, -la]);
  const xs = xy.map((p) => p[0]);
  const ys = xy.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 300;
  const H = (height / 150) * 150;
  const pad = 10;
  const scale = Math.min((W - 2 * pad) / (maxX - minX || 1e-9), (H - 2 * pad) / (maxY - minY || 1e-9));
  const ox = (W - (maxX - minX) * scale) / 2;
  const oy = (H - (maxY - minY) * scale) / 2;
  const P = (p: number[]) => [ox + (p[0] - minX) * scale, oy + (p[1] - minY) * scale];
  const d = xy.map((p, i) => `${i ? "L" : "M"}${P(p)[0].toFixed(1)},${P(p)[1].toFixed(1)}`).join("");
  const [sx, sy] = P(xy[0]);
  const [ex, ey] = P(xy[xy.length - 1]);
  return (
    <svg className="route" viewBox={`0 0 ${W} ${H}`} width="100%" height={height} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Route">
      <path d={d} className="route-line-bg" />
      <path d={d} className="route-line" />
      <circle cx={sx} cy={sy} r={5} className="route-start" />
      <circle cx={ex} cy={ey} r={5} className="route-end" />
    </svg>
  );
}
