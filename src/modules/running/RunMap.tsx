import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodePolyline } from "./route";

/** Metres between two [lat, lng] points. */
function metres(a: [number, number], b: [number, number]) {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Where each whole kilometre falls along the route. */
export function kmMarkers(pts: [number, number][]): { km: number; at: [number, number] }[] {
  const out: { km: number; at: [number, number] }[] = [];
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    const step = metres(pts[i - 1], pts[i]);
    while (d + step >= (out.length + 1) * 1000) {
      const f = ((out.length + 1) * 1000 - d) / step;
      out.push({ km: out.length + 1, at: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f] });
    }
    d += step;
  }
  return out;
}

const dark = () => document.documentElement.dataset.theme !== "light";

/** The run on a real map, full screen: pan and pinch, start and finish, a marker each kilometre. */
export function RunMap({ polyline, title, onClose }: { polyline: string; title: string; onClose: () => void }) {
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const pts = decodePolyline(polyline);
    if (pts.length < 2) return;
    const map = L.map(el.current, { zoomControl: false, attributionControl: true });
    // OpenStreetMap's own tiles (free, no key); dimmed and inverted in dark mode by CSS.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      className: dark() ? "rm-tiles-dark" : "",
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff8c42";
    // A dark edge under the line keeps it readable on any map.
    L.polyline(pts, { color: "#000", weight: 8, opacity: 0.25 }).addTo(map);
    const line = L.polyline(pts, { color: accent, weight: 5, opacity: 0.95, lineJoin: "round" }).addTo(map);
    const dot = (at: [number, number], cls: string, html = "") => L.marker(at, { icon: L.divIcon({ className: `rm-pin ${cls}`, html, iconSize: cls === "rm-km" ? [22, 22] : [16, 16] }), interactive: false }).addTo(map);
    for (const m of kmMarkers(pts)) dot(m.at, "rm-km", String(m.km));
    dot(pts[0], "rm-start");
    dot(pts[pts.length - 1], "rm-end");
    map.fitBounds(line.getBounds(), { padding: [40, 40] });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    return () => void map.remove();
  }, [polyline]);
  return createPortal(
    <div className="run-map" role="dialog" aria-label={`Map of ${title}`}>
      <div className="run-map-head">
        <b>{title}</b>
        <button type="button" className="run-close" onClick={onClose} aria-label="Close the map">
          <span aria-hidden="true">✕</span>
          <span className="run-close-label">Close</span>
        </button>
      </div>
      <div ref={el} className="run-map-canvas" data-noswipe />
    </div>,
    document.body,
  );
}
