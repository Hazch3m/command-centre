import { useEffect, useState } from "react";
import { backend } from "@backend";
import { useDataVersion } from "../../core/events";
import { addDays, relativeDayLabel, useEvery, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { LineChart } from "../../shell/charts";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { duration } from "../running/stats";
import { loadFitnessConfig } from "../running/fitness";
import { loadRuns } from "../running/strava";
import { trimp } from "../running/vo2";
import { ownReadiness, type Readiness } from "./readiness";

/** Heart-rate training load per day (same TRIMP as the Fitness page), for the readiness score. */
function useDailyLoad() {
  const version = useDataVersion("running");
  return useQuery(async () => {
    const [runs, cfg] = await Promise.all([loadRuns(addDays(new Date().toISOString().slice(0, 10), -60)), loadFitnessConfig()]);
    return runs.map((r) => ({ date: r.date, load: trimp(r.moving_time, r.avg_hr, cfg) }));
  }, [version]).data;
}
import { getHealthSync, latest, loadHealth, migrations, syncHealth, type HealthDay } from "./data";

const hm = (s: number | null | undefined) => (s == null ? "–" : `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`);
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};
const HRV_TONE: Record<string, string> = { BALANCED: "tone-accent", UNBALANCED: "tone-warn", LOW: "tone-danger", POOR: "tone-danger" };
const READY_TONE = (s: number | null | undefined) => (s == null ? "" : s >= 60 ? "tone-accent" : s >= 35 ? "tone-warn" : "tone-danger");
const nice = (s: string | null | undefined) => (s ? s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");

/** Tiny line of the last two weeks. */
function Spark({ values, invert }: { values: (number | null)[]; invert?: boolean }) {
  const v = values.map((x, i) => [i, x] as const).filter((p): p is readonly [number, number] => p[1] != null);
  if (v.length < 2) return <svg className="spark" viewBox="0 0 100 24" />;
  const lo = Math.min(...v.map((p) => p[1]));
  const hi = Math.max(...v.map((p) => p[1]));
  const y = (x: number) => (hi === lo ? 12 : 22 - ((x - lo) / (hi - lo)) * 20);
  const d = v.map((p, i) => `${i ? "L" : "M"}${(p[0] / (values.length - 1)) * 100},${invert ? 24 - y(p[1]) : y(p[1])}`).join(" ");
  return (
    <svg className="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Metric({ label, value, unit, note, tone, spark, when }: { label: string; value: string; unit?: string; note?: string; tone?: string; spark?: (number | null)[]; when?: string }) {
  return (
    <div className="hm" title={when}>
      <div className="label">{label}</div>
      <div className="hm-value">
        <span className={"num " + (tone ?? "")}>{value}</span>
        {unit && <span className="muted small"> {unit}</span>}
      </div>
      {note && <div className="muted small hm-note">{note}</div>}
      {spark && <Spark values={spark} />}
    </div>
  );
}

function useHealth(days: number) {
  const version = useDataVersion("health");
  const { data } = useQuery(() => Promise.all([loadHealth(days), getHealthSync(), backend.garminStatus().catch(() => ({ connected: false }))]), [version, days]);
  useEvery(30 * 60_000, () => {
    syncHealth().catch(() => {});
  });
  // Mornings: the watch often reaches Garmin after the app's last sync, so until
  // last night's sleep has arrived, check every 5 minutes (and when the window gets focus).
  const today = useToday();
  const hasLastNight = !!data?.[0]?.some((d) => d.date === today && d.sleep_secs != null);
  useEvery(5 * 60_000, () => {
    const h = new Date().getHours();
    if (!hasLastNight && h >= 4 && h < 14 && data?.[2]?.connected) syncHealth().catch(() => {});
  }, [hasLastNight, !!data?.[2]?.connected]);
  useEffect(() => {
    if (hasLastNight) return;
    const f = () => syncHealth().catch(() => {});
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [hasLastNight]);
  return data;
}

function Connect() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="health-connect">
      <p>
        Connect Garmin to see VO2 max, HRV, sleep, resting heart rate, Body Battery, training readiness and Garmin's race predictions here. A Garmin sign-in window opens;
        your password and two-step code go straight to Garmin.
      </p>
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await backend.garminConnect();
            await syncHealth();
          } catch (e) {
            setErr(String((e as Error)?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for Garmin sign-in…" : "Connect Garmin"}
      </button>
      <ErrorNote error={err} />
      <p className="muted small">
        Garmin has no public API for personal use, so this signs in the way Garmin's phone app does. It's read-only. If Garmin changes its sign-in, this may stop working
        until the app is updated; your cached data stays.
      </p>
    </div>
  );
}

function Metrics({ rows, today, detail }: { rows: HealthDay[]; today: string; detail?: boolean }) {
  const L = latest(rows);
  const load = useDailyLoad();
  const ownFor = (d: string): Readiness | null => (load ? ownReadiness(rows, d, load) : null);
  const own = ownFor(today);
  const last14 = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
  const by = new Map(rows.map((r) => [r.date, r]));
  const series = (f: keyof HealthDay) => last14.map((d) => (by.get(d)?.[f] as number | null) ?? null);
  const rhr7 = avg(series("rhr").slice(-7));
  const rhrPrev = avg(series("rhr").slice(0, 7));
  const ownSeries = last14.map((d) => ownFor(d)?.score ?? null);
  const when = (f: keyof HealthDay) => (L.dates[f as Exclude<keyof HealthDay, "date">] ? relativeDayLabel(L.dates[f as Exclude<keyof HealthDay, "date">]!, today) : undefined);
  return (
    <>
    <div className="hm-grid">
      {L.readiness != null && L.dates.readiness === today ? (
        <Metric
          label="Training readiness"
          value={String(Math.round(L.readiness))}
          tone={READY_TONE(L.readiness)}
          note={nice(L.readiness_level) || nice(L.readiness_note)}
          spark={series("readiness")}
          when="Garmin"
        />
      ) : (
        <Metric
          label="Readiness"
          value={own ? String(own.score) : "–"}
          tone={READY_TONE(own?.score)}
          note={own ? `${own.level} · ${own.advice}${own.limiter ? ` · held back by ${own.limiter.name.toLowerCase()}` : ""}` : "Needs last night's HRV or sleep"}
          spark={ownSeries}
          when={own ? own.parts.map((p) => `${p.name} ${Math.round(p.score)}: ${p.note}`).join("\n") + "\n(Worked out from HRV, sleep, resting HR and training load)" : undefined}
        />
      )}
      <Metric
        label={L.dates.hrv === today ? "HRV last night" : "HRV"}
        value={L.hrv != null ? String(Math.round(L.hrv)) : "–"}
        unit="ms"
        tone={L.hrv_status ? HRV_TONE[L.hrv_status] : ""}
        note={`${L.hrv_week != null ? `7-day ${Math.round(L.hrv_week)}` : ""}${L.hrv_low != null && L.hrv_high != null ? ` · normal ${Math.round(L.hrv_low)}–${Math.round(L.hrv_high)}` : ""}${L.hrv_status ? ` · ${nice(L.hrv_status)}` : ""}`}
        spark={series("hrv")}
        when={when("hrv")}
      />
      <Metric
        label="Resting HR"
        value={L.rhr != null ? String(Math.round(L.rhr)) : "–"}
        unit="bpm"
        note={rhr7 != null && rhrPrev != null ? `7-day ${rhr7.toFixed(0)} (${rhr7 - rhrPrev >= 0 ? "+" : ""}${(rhr7 - rhrPrev).toFixed(1)} vs week before)` : undefined}
        tone={rhr7 != null && rhrPrev != null && rhr7 - rhrPrev > 3 ? "tone-warn" : ""}
        spark={series("rhr")}
        when={when("rhr")}
      />
      <Metric
        label={L.dates.sleep_secs === today ? "Sleep last night" : "Sleep"}
        value={hm(L.sleep_secs)}
        unit="h"
        note={[L.sleep_score != null ? `Score ${Math.round(L.sleep_score)}` : null, L.dates.sleep_secs && L.dates.sleep_secs !== today ? `night to ${relativeDayLabel(L.dates.sleep_secs, today).toLowerCase()}` : L.sleep_end ? `woke ${L.sleep_end}` : null].filter(Boolean).join(" · ") || undefined}
        spark={series("sleep_secs")}
        when={when("sleep_secs")}
      />
      <Metric
        label="Body Battery"
        value={L.bb_now != null ? String(Math.round(L.bb_now)) : L.bb_high != null ? String(Math.round(L.bb_high)) : "–"}
        note={L.bb_high != null ? `High ${Math.round(L.bb_high)} · low ${Math.round(L.bb_low ?? 0)}` : undefined}
        tone={READY_TONE(L.bb_now ?? L.bb_high)}
        spark={series("bb_high")}
        when={when("bb_high")}
      />
      <Metric label="VO2 max (Garmin)" value={L.vo2 != null ? L.vo2.toFixed(1) : "–"} spark={series("vo2")} when={when("vo2")} />
    </div>
    {detail && own && !(L.readiness != null && L.dates.readiness === today) && (
      <div className="ready-parts">
        <span className="label">Readiness today, worked out from</span>
        {own.parts.map((p) => (
          <div key={p.name} className="ready-part">
            <span>{p.name}</span>
            <span className="ready-bar"><span className={READY_TONE(p.score).replace("tone-", "fill-")} style={{ width: `${p.score}%` }} /></span>
            <span className="num">{Math.round(p.score)}</span>
            <span className="muted small">{p.note}</span>
          </div>
        ))}
      </div>
    )}
    </>
  );
}

function HealthCard({ variant, editing }: CardProps) {
  const today = useToday();
  const page = variant === "page";
  const data = useHealth(page ? 180 : 30);
  useEffect(() => {
    syncHealth().catch(() => {});
  }, []);
  const [rows, sync, status] = data ?? [[], null, null];
  const right = sync?.lastSync ? (
    <button className="btn icon ghost sync-btn" onClick={() => syncHealth()} title="Sync with Garmin now">
      ↻ <span className="small">{sync.offline ? "Offline" : new Date(sync.lastSync).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
    </button>
  ) : undefined;
  if (data && !status?.connected && !rows.length)
    return (
      <>
        <CardHeader title="Health" to={editing ? undefined : "health"} />
        <Connect />
      </>
    );
  return (
    <>
      <CardHeader title="Health" to={editing ? undefined : "health"} right={right} />
      {!status?.connected && data && <div className="muted small">Garmin isn't connected — showing saved data. Connect again in Settings.</div>}
      <Metrics rows={rows} today={today} detail={page} />
      {page && <HealthCharts rows={rows} today={today} />}
      {sync && sync.errors.length > 0 && (
        <details className="muted small health-diag">
          <summary>
            {sync.errors.length} of Garmin's {sync.errors.length + sync.got.length} data sources didn't answer
          </summary>
          {sync.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </details>
      )}
    </>
  );
}

function HealthCharts({ rows, today }: { rows: HealthDay[]; today: string }) {
  const from = rows.length && rows[0].date > addDays(today, -180) ? rows[0].date : addDays(today, -180);
  const pts = (f: keyof HealthDay, scale = 1) => rows.map((r) => ({ x: r.date, y: r[f] == null ? null : (r[f] as number) * scale }));
  const preds = rows.filter((r) => r.pred_10k != null);
  const first = preds[0];
  const last = preds[preds.length - 1];
  return (
    <div className="health-charts">
      <h3>HRV</h3>
      <LineChart
        from={from}
        to={today}
        height={150}
        digits={0}
        unit=" ms"
        series={[
          { name: "Normal range (high)", kind: "dashed", className: "s-proj", points: pts("hrv_high") },
          { name: "Normal range (low)", kind: "dashed", className: "s-proj", points: pts("hrv_low") },
          { name: "Last night", kind: "dots", className: "s-est", points: pts("hrv") },
          { name: "7-day average", kind: "line", className: "s-trend", points: pts("hrv_week") },
        ]}
      />
      <h3>Resting heart rate</h3>
      <LineChart from={from} to={today} height={130} digits={0} unit=" bpm" series={[{ name: "Resting HR", kind: "line", className: "s-acute", points: pts("rhr") }]} />
      <h3>Sleep</h3>
      <LineChart
        from={from}
        to={today}
        height={130}
        digits={1}
        series={[
          { name: "Hours", kind: "dots", className: "s-est", points: pts("sleep_secs", 1 / 3600) },
          { name: "Score ÷ 10", kind: "line", className: "s-trend", points: pts("sleep_score", 0.1) },
        ]}
      />
      <h3>VO2 max (Garmin)</h3>
      <LineChart from={from} to={today} height={130} series={[{ name: "VO2 max", kind: "line", className: "s-trend", points: pts("vo2") }]} />
      {last && (
        <>
          <h3>Garmin's race predictions</h3>
          <table className="table">
            <thead>
              <tr>
                <th>Distance</th>
                <th className="num-col">Now</th>
                <th className="num-col">{first && first !== last ? relativeDayLabel(first.date, today) : ""}</th>
                <th className="num-col">Change</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["5k", "pred_5k"],
                  ["10k", "pred_10k"],
                  ["Half", "pred_half"],
                  ["Marathon", "pred_marathon"],
                ] as const
              ).map(([n, f]) => {
                const a = first?.[f];
                const b = last[f];
                return (
                  <tr key={n}>
                    <td>{n}</td>
                    <td className="num-col">{b ? duration(b) : "–"}</td>
                    <td className="num-col muted">{a && first !== last ? duration(a) : ""}</td>
                    <td className={"num-col " + (a && b ? (b < a ? "tone-accent" : b > a ? "tone-danger" : "") : "")}>{a && b && first !== last ? `${b <= a ? "−" : "+"}${duration(Math.abs(b - a))}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export const healthModule: DashboardModule = {
  id: "health",
  title: "Health",
  defaultPos: { x: 0, y: 16, w: 6, h: 9 },
  minW: 4,
  minH: 4,
  migrations,
  Card: HealthCard,
  page: { label: "Health", order: 2.5 },
};

/** Settings row: connect or disconnect Garmin. */
export function GarminSetting() {
  const version = useDataVersion("health");
  const [tick, setTick] = useState(0);
  const { data: status } = useQuery(() => backend.garminStatus().catch(() => ({ connected: false })), [version, tick]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="connection">
      <div className="connection-head">
        <strong>Garmin</strong>
        <span className={status?.connected ? "tone-accent small" : "muted small"}>{status?.connected ? "Connected" : "Not connected"}</span>
      </div>
      <div className="muted small">Health tab: VO2 max, HRV, sleep, resting HR, Body Battery, readiness, race predictions (read-only).</div>
      <div className="inline">
        {status?.connected ? (
          <button className="btn" onClick={() => backend.garminDisconnect().then(() => setTick((t) => t + 1))}>
            Disconnect
          </button>
        ) : (
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                await backend.garminConnect();
                setTick((t) => t + 1);
                await syncHealth();
              } catch (e) {
                setErr(String((e as Error)?.message ?? e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Waiting for Garmin sign-in…" : "Connect Garmin"}
          </button>
        )}
      </div>
      <ErrorNote error={err} />
    </div>
  );
}

