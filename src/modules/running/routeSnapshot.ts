import type { Map as MlMap } from "maplibre-gl";
import { decodePolyline } from "./route";

/**
 * Pictures of runs on the real map, for lists: one hidden map draws each route in turn
 * (phones only allow a few live maps at once), and the pictures are kept for next time.
 */

const dark = () => document.documentElement.dataset.theme !== "light";
const STYLE = (d: boolean) => `https://tiles.openfreemap.org/styles/${d ? "dark" : "liberty"}`;
const KEY = "cc-route-pics";
const MAX = 60;

const mem = new Map<string, string>();
function stored(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}
function keep(k: string, url: string) {
  mem.set(k, url);
  try {
    const all = stored();
    all[k] = url;
    const keys = Object.keys(all);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX))) delete all[old];
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* full or private: memory only */
  }
}
function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
export function cachedPic(polyline: string, w: number, h: number): string | null {
  const k = `${hash(polyline)}-${w}x${h}-${dark() ? "d" : "l"}`;
  return mem.get(k) ?? stored()[k] ?? null;
}

let map: Promise<{ map: MlMap; el: HTMLDivElement; style: string }> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getMap(style: string) {
  if (!map)
    map = (async () => {
      const ml = (await import("maplibre-gl")).default;
      const el = document.createElement("div");
      el.style.cssText = "position:fixed;left:-10000px;top:0;width:360px;height:180px;pointer-events:none;";
      document.body.appendChild(el);
      const m = new ml.Map({ container: el, style, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { preserveDrawingBuffer: true }, pixelRatio: 2 });
      await new Promise<void>((r) => m.once("load", () => r()));
      return { map: m, el, style };
    })();
  const s = await map;
  if (s.style !== style) {
    s.map.setStyle(style);
    s.style = style;
    await new Promise<void>((r) => s.map.once("style.load", () => r()));
  }
  return s;
}

const idle = (m: MlMap) =>
  new Promise<void>((r) => {
    const t = window.setTimeout(r, 8000);
    m.once("idle", () => {
      window.clearTimeout(t);
      r();
    });
  });

async function draw(polyline: string, w: number, h: number, accent: string): Promise<string | null> {
  const pts = decodePolyline(polyline);
  if (pts.length < 2) return null;
  const { map: m, el } = await getMap(STYLE(dark()));
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  m.resize();
  const line = { type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: pts.map(([a, b]) => [b, a]) } };
  const ends = {
    type: "FeatureCollection" as const,
    features: [pts[0], pts[pts.length - 1]].map(([a, b], i) => ({ type: "Feature" as const, properties: { end: i }, geometry: { type: "Point" as const, coordinates: [b, a] } })),
  };
  const src = m.getSource("snap") as { setData?: (d: unknown) => void } | undefined;
  if (src?.setData) {
    src.setData(line);
    (m.getSource("snap-ends") as { setData: (d: unknown) => void }).setData(ends);
    m.setPaintProperty("snap-line", "line-color", accent);
  } else {
    m.addSource("snap", { type: "geojson", data: line });
    m.addSource("snap-ends", { type: "geojson", data: ends });
    m.addLayer({ id: "snap-edge", type: "line", source: "snap", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 6 } });
    m.addLayer({ id: "snap-line", type: "line", source: "snap", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": accent, "line-width": 3.5 } });
    m.addLayer({
      id: "snap-dots",
      type: "circle",
      source: "snap-ends",
      paint: { "circle-radius": 4.5, "circle-color": ["match", ["get", "end"], 0, "#22c55e", "#ef4444"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
    });
  }
  const lats = pts.map((p) => p[0]);
  const lngs = pts.map((p) => p[1]);
  m.fitBounds(
    [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    { padding: 18, maxZoom: 15.5, animate: false },
  );
  await idle(m);
  try {
    return m.getCanvas().toDataURL("image/jpeg", 0.8);
  } catch {
    return null;
  }
}

/** A picture of the route on the map, w×h CSS pixels (one at a time; cached). */
export function routePic(polyline: string, w: number, h: number): Promise<string | null> {
  const k = `${hash(polyline)}-${w}x${h}-${dark() ? "d" : "l"}`;
  const hit = mem.get(k) ?? stored()[k];
  if (hit) return Promise.resolve(hit);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#fc5200";
  const job = queue.then(() => draw(polyline, w, h, accent)).then((url) => {
    if (url) keep(k, url);
    return url;
  });
  queue = job.catch(() => null);
  return job.catch(() => null);
}
