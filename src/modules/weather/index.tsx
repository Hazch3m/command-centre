import { useEffect, useState } from "react";
import { backend } from "@backend";
import { kvGet, kvSet } from "../../core/db";
import { notifyChanged, useDataVersion } from "../../core/events";
import { useEvery, useNow } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";

export interface Place {
  name: string;
  lat: number;
  lon: number;
}
const PLACES: Place[] = [
  { name: "Geneva", lat: 46.2044, lon: 6.1432 },
  { name: "CERN (Meyrin)", lat: 46.2338, lon: 6.0557 },
  { name: "Lausanne", lat: 46.5197, lon: 6.6323 },
  { name: "Zurich", lat: 47.3769, lon: 8.5417 },
  { name: "Dublin", lat: 53.3498, lon: -6.2603 },
];

interface Forecast {
  current?: { time: string; temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number };
  hourly: { time: string[]; temperature_2m: number[]; apparent_temperature: number[]; precipitation_probability: number[]; precipitation: number[]; wind_speed_10m: number[]; weather_code: number[]; is_day: number[] };
  daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[]; sunrise: string[]; sunset: string[] };
}

/** WMO weather codes → words and a symbol. */
export function describe(code: number, day = true): { text: string; icon: string } {
  if (code === 0) return { text: "Clear", icon: day ? "☀️" : "🌙" };
  if (code <= 2) return { text: "Partly cloudy", icon: day ? "⛅" : "☁️" };
  if (code === 3) return { text: "Overcast", icon: "☁️" };
  if (code <= 48) return { text: "Fog", icon: "🌫️" };
  if (code <= 57) return { text: "Drizzle", icon: "🌦️" };
  if (code <= 67) return { text: "Rain", icon: "🌧️" };
  if (code <= 77) return { text: "Snow", icon: "🌨️" };
  if (code <= 82) return { text: "Showers", icon: "🌦️" };
  if (code <= 86) return { text: "Snow showers", icon: "🌨️" };
  return { text: "Thunderstorm", icon: "⛈️" };
}

/**
 * The best hour to run in what's left of today's daylight: little rain, little
 * wind, and a feels-like temperature near 8–15 °C.
 */
export function bestRunHour(f: Forecast, nowIso: string): number | null {
  const today = nowIso.slice(0, 10);
  const sunset = f.daily.time.indexOf(today) >= 0 ? f.daily.sunset[f.daily.time.indexOf(today)] : null;
  let best: number | null = null;
  let bestScore = Infinity;
  f.hourly.time.forEach((t, i) => {
    if (t.slice(0, 10) !== today || t.slice(0, 13) < nowIso.slice(0, 13) || !f.hourly.is_day[i]) return;
    if (sunset && t > sunset) return;
    const feels = f.hourly.apparent_temperature[i];
    const score =
      f.hourly.precipitation_probability[i] * 0.6 + f.hourly.precipitation[i] * 25 + f.hourly.wind_speed_10m[i] * 0.7 + Math.max(0, 8 - feels) * 3 + Math.max(0, feels - 15) * 3;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

const hh = (iso: string) => iso.slice(11, 16);

/** Now, in a few words, and the best hour left today to run (for Today's run card). */
export function useWeatherBrief(): { temp: number; text: string; icon: string; best: string | null } | null {
  const now = useNow("minute");
  const version = useDataVersion("weather");
  const { data } = useQuery(load, [version]);
  useEffect(() => {
    if (!data) return;
    const stale = !data.fetchedAt || Date.now() - Date.parse(data.fetchedAt) > 60 * 60_000;
    if (stale) void refresh(data.place).catch(() => {});
  }, [data?.place.lat, data?.fetchedAt]);
  const f = data?.data;
  if (!f?.current) return null;
  const nowIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:00`;
  const d = describe(f.current.weather_code, true);
  const b = bestRunHour(f, nowIso);
  return { temp: Math.round(f.current.temperature_2m), text: d.text.toLowerCase(), icon: d.icon, best: b != null ? hh(f.hourly.time[b]) : null };
}
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function load(): Promise<{ place: Place; data: Forecast | null; fetchedAt: string | null; error: string | null }> {
  const place = await kvGet<Place>("weather.place", PLACES[0]);
  const cached = await kvGet<{ data: Forecast; at: string } | null>("weather.cache", null);
  return { place, data: cached?.data ?? null, fetchedAt: cached?.at ?? null, error: null };
}

async function refresh(place: Place) {
  try {
    const data = (await backend.weatherFetch(place.lat, place.lon)) as Forecast;
    await kvSet("weather.cache", { data, at: new Date().toISOString() });
    await kvSet("weather.error", null);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await kvSet("weather.error", msg.startsWith("offline") ? null : msg);
  }
  await notifyChanged("weather");
}

/** For the refresh button: the forecast for the chosen place, now. */
export async function refreshWeather() {
  await refresh((await load()).place);
}

function WeatherCard({ editing }: CardProps) {
  const now = useNow("minute");
  const version = useDataVersion("weather");
  const { data } = useQuery(() => Promise.all([load(), kvGet<string | null>("weather.error", null)]), [version]);
  const [choosing, setChoosing] = useState(false);
  const place = data?.[0].place;
  useEffect(() => {
    if (place) refresh(place);
  }, [place?.lat, place?.lon]);
  useEvery(30 * 60_000, () => {
    if (place) refresh(place);
  });
  const f = data?.[0].data;
  const error = data?.[1] ?? null;
  const nowIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:00`;

  const header = (
    <CardHeader
      title={`Weather${place ? ` · ${place.name}` : ""}`}
      right={
        <button className="btn icon ghost" onClick={() => !editing && setChoosing((c) => !c)} aria-label="Change place" title="Change place">
          ✎
        </button>
      }
    />
  );
  if (choosing)
    return (
      <>
        {header}
        <div className="weather-places">
          {PLACES.map((p) => (
            <button
              key={p.name}
              className={"chip-btn" + (place?.name === p.name ? " on" : "")}
              onClick={async () => {
                await kvSet("weather.place", p);
                await kvSet("weather.cache", null);
                setChoosing(false);
                await notifyChanged("weather");
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </>
    );
  if (!f)
    return (
      <>
        {header}
        <div className="muted small">{error ?? "Loading the forecast…"}</div>
      </>
    );

  const start = Math.max(0, f.hourly.time.findIndex((t) => t.slice(0, 13) >= nowIso.slice(0, 13)));
  const cur = f.current;
  const curDesc = describe(cur?.weather_code ?? f.hourly.weather_code[start], !!f.hourly.is_day[start]);
  const best = bestRunHour(f, nowIso);
  const ti = f.daily.time.indexOf(nowIso.slice(0, 10));
  const hours = f.hourly.time.slice(start, start + 12).map((t, k) => ({ t, i: start + k }));
  return (
    <>
      {header}
      <div className="wx">
        <div className="wx-now">
          <span className="wx-icon" aria-hidden="true">
            {curDesc.icon}
          </span>
          <span className="num wx-temp">{Math.round(cur?.temperature_2m ?? f.hourly.temperature_2m[start])}°</span>
          <div className="wx-now-text small">
            <div>{curDesc.text}</div>
            <div className="muted">
              Feels {Math.round(cur?.apparent_temperature ?? f.hourly.apparent_temperature[start])}° · wind {Math.round(cur?.wind_speed_10m ?? f.hourly.wind_speed_10m[start])} km/h
            </div>
            {ti >= 0 && (
              <div className="muted">
                {Math.round(f.daily.temperature_2m_min[ti])}°–{Math.round(f.daily.temperature_2m_max[ti])}° · ☀ {hh(f.daily.sunrise[ti])}–{hh(f.daily.sunset[ti])}
              </div>
            )}
          </div>
        </div>
        {best != null ? (
          <div className="wx-run small">
            <span className="label">Best time to run</span> <b className="num">{hh(f.hourly.time[best])}</b> · {Math.round(f.hourly.apparent_temperature[best])}° feels · {f.hourly.precipitation_probability[best]}% rain · {Math.round(f.hourly.wind_speed_10m[best])} km/h
          </div>
        ) : (
          <div className="wx-run small muted">No daylight left today.</div>
        )}
        <div className="wx-hours">
          {hours.map(({ t, i }) => (
            <div key={t} className={"wx-hour" + (i === best ? " best" : "")} title={`${hh(t)}: ${describe(f.hourly.weather_code[i]).text}, ${f.hourly.precipitation_probability[i]}% rain`}>
              <span className="muted">{hh(t).slice(0, 2)}</span>
              <span aria-hidden="true">{describe(f.hourly.weather_code[i], !!f.hourly.is_day[i]).icon}</span>
              <span className="num">{Math.round(f.hourly.temperature_2m[i])}°</span>
              <span className="wx-rain" style={{ opacity: 0.25 + f.hourly.precipitation_probability[i] / 133 }}>
                {f.hourly.precipitation_probability[i]}%
              </span>
            </div>
          ))}
        </div>
        <div className="wx-days small">
          {f.daily.time.slice(ti + 1, ti + 3).map((d, k) => {
            const i = ti + 1 + k;
            return (
              <span key={d}>
                {DOW[new Date(d + "T12:00:00").getDay()]} {describe(f.daily.weather_code[i]).icon} {Math.round(f.daily.temperature_2m_min[i])}°–{Math.round(f.daily.temperature_2m_max[i])}° ·{" "}
                {f.daily.precipitation_probability_max[i]}%
              </span>
            );
          })}
        </div>
        <ErrorNote error={error} />
      </div>
    </>
  );
}

export const weatherModule: DashboardModule = {
  id: "weather",
  title: "Weather",
  defaultPos: { x: 0, y: 0, w: 6, h: 6 },
  minW: 3,
  minH: 3,
  Card: WeatherCard,
};
