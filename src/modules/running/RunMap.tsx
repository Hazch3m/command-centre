import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
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

/** The map looks: clean vector maps (OpenFreeMap, free and keyless) and satellite photos (Esri). */
export const MAP_STYLES = [
  { id: "standard", label: "Standard" },
  { id: "light", label: "Light" },
  { id: "satellite", label: "Satellite" },
  { id: "dark", label: "Dark" },
] as const;
export type MapStyleId = (typeof MAP_STYLES)[number]["id"];

const SATELLITE: StyleSpecification = {
  version: 8,
  sources: {
    sat: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [{ id: "sat", type: "raster", source: "sat" }],
};
const styleUrl = (id: MapStyleId): string | StyleSpecification =>
  id === "satellite" ? SATELLITE : `https://tiles.openfreemap.org/styles/${id === "standard" ? "liberty" : id === "light" ? "positron" : "dark"}`;

const KEY = "cc-map-style";
function savedStyle(): MapStyleId {
  try {
    const s = localStorage.getItem(KEY) as MapStyleId | null;
    if (s && MAP_STYLES.some((x) => x.id === s)) return s;
  } catch {
    /* private mode */
  }
  return dark() ? "dark" : "standard";
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#fc5200";

/** The route as map layers: a white edge under a bold line, Strava style. Added again after a style change. */
function addRoute(map: MlMap, pts: [number, number][]) {
  const coords = pts.map(([la, ln]) => [ln, la]);
  if (map.getSource("route")) return;
  map.addSource("route", { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
  map.addLayer({ id: "route-edge", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 5, 16, 10], "line-opacity": 0.95 } });
  map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": accent(), "line-width": ["interpolate", ["linear"], ["zoom"], 10, 3, 16, 6] } });
}

function bounds(pts: [number, number][]): [[number, number], [number, number]] {
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

function pin(cls: string, text = "") {
  const el = document.createElement("div");
  el.className = `rm-pin ${cls}`;
  el.textContent = text;
  return el;
}

/** Make a map in `el` showing the route; resolves to the map (remove it when done). */
async function makeMap(el: HTMLElement, pts: [number, number][], style: MapStyleId, opts: { interactive: boolean; markers: boolean; padding: number }) {
  const ml = (await import("maplibre-gl")).default;
  const map = new ml.Map({
    container: el,
    style: styleUrl(style),
    bounds: bounds(pts),
    fitBoundsOptions: { padding: opts.padding, maxZoom: 16 },
    interactive: opts.interactive,
    attributionControl: { compact: true },
    pitchWithRotate: false,
    dragRotate: false,
    fadeDuration: 150,
  });
  if (opts.interactive) map.touchZoomRotate.disableRotation();
  map.on("style.load", () => addRoute(map, pts));
  if (opts.markers) {
    for (const m of kmMarkers(pts)) new ml.Marker({ element: pin("rm-km", String(m.km)) }).setLngLat([m.at[1], m.at[0]]).addTo(map);
  }
  new ml.Marker({ element: pin("rm-start") }).setLngLat([pts[0][1], pts[0][0]]).addTo(map);
  new ml.Marker({ element: pin("rm-end") }).setLngLat([pts[pts.length - 1][1], pts[pts.length - 1][0]]).addTo(map);
  return map;
}

/** A small live map of the run (not draggable): tap it for the full map. */
export function RunMapThumb({ polyline, height = 170 }: { polyline: string | null; height?: number }) {
  const el = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el.current || !polyline) return;
    const pts = decodePolyline(polyline);
    if (pts.length < 2) return;
    let map: MlMap | null = null;
    let gone = false;
    makeMap(el.current, pts, savedStyle() === "satellite" ? "satellite" : dark() ? "dark" : "standard", { interactive: false, markers: false, padding: 22 }).then((m) => {
      if (gone) m.remove();
      else map = m;
    });
    return () => {
      gone = true;
      map?.remove();
    };
  }, [polyline]);
  if (!polyline) return <div className="route-empty muted small">No map for this run</div>;
  return <div ref={el} className="rm-thumb" style={{ height }} />;
}

/** The run on a real map, full screen: pan and pinch, start and finish, a marker each kilometre, four looks. */
export function RunMap({ polyline, title, onClose }: { polyline: string; title: string; onClose: () => void }) {
  const el = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [style, setStyle] = useState<MapStyleId>(savedStyle);
  const pts = useRef(decodePolyline(polyline));
  useEffect(() => {
    pts.current = decodePolyline(polyline);
    if (!el.current || pts.current.length < 2) return;
    let gone = false;
    makeMap(el.current, pts.current, style, { interactive: true, markers: true, padding: 48 }).then(async (m) => {
      if (gone) return m.remove();
      mapRef.current = m;
      const { default: ml } = await import("maplibre-gl");
      m.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
    });
    return () => {
      gone = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
    // The style changes in place (below), not by making a new map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polyline]);
  const pick = (s: MapStyleId) => {
    setStyle(s);
    try {
      localStorage.setItem(KEY, s);
    } catch {
      /* private mode */
    }
    mapRef.current?.setStyle(styleUrl(s));
  };
  const recentre = () => mapRef.current?.fitBounds(bounds(pts.current), { padding: 48, maxZoom: 16, duration: 600 });
  return createPortal(
    <div className="run-map" role="dialog" aria-label={`Map of ${title}`}>
      <div className="run-map-head">
        <b>{title}</b>
        <button type="button" className="run-close" onClick={onClose} aria-label="Close the map">
          <span aria-hidden="true">✕</span>
          <span className="run-close-label">Close</span>
        </button>
      </div>
      <div className="run-map-body">
        <div ref={el} className="run-map-canvas" data-noswipe />
        <div className="rm-styles" role="radiogroup" aria-label="Map style">
          {MAP_STYLES.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={style === s.id} className={`rm-style rm-style-${s.id}` + (style === s.id ? " on" : "")} onClick={() => pick(s.id)}>
              <i aria-hidden="true" />
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="rm-recentre" onClick={recentre} aria-label="Show the whole route">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
            <circle cx="12" cy="12" r="5" />
          </svg>
        </button>
      </div>
    </div>,
    document.body,
  );
}
