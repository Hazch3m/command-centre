import { useMemo, useRef, useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey } from "../core/time";
import { useQuery } from "../core/useQuery";
import { latest, loadHealth, type HealthDay } from "../modules/health/data";
import { useFitness } from "../modules/running/fitness";
import { dailyLoad, formLevel, loadSeries, monotony } from "../modules/running/runalyze";
import { useRunningData } from "../modules/running/useRunning";
import { Ring, toneFor, usePhoneNav, useReadiness } from "./common";

const hm = (s: number) => `${Math.floor(s / 3600)}:${String(Math.round((s % 3600) / 60)).padStart(2, "0")}`;
const FORM_WORD = { fresh: "Fresh", neutral: "Steady", productive: "Productive", tired: "Tired", overload: "Overloaded" } as const;

/**
 * Today's health at a glance, on three pages you swipe between (dots underneath):
 * readiness and last night, training load and form, and the last week's trends.
 */
export function HealthPanel({ today }: { today: string }) {
  const nav = usePhoneNav();
  const ready = useReadiness(today);
  const hv = useDataVersion("health");
  const rows = useQuery(() => loadHealth(21), [hv]).data ?? [];
  const last = latest(rows);
  const night = rows.find((r) => r.date === today) ?? rows[rows.length - 1];
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const load = useMemo(() => {
    if (!f) return null;
    const daily = dailyLoad(runs, f.config);
    const s = loadSeries(daily, addDays(today, -13), today);
    const p = s[s.length - 1];
    return p ? { ...p, level: formLevel(p), mono: monotony(daily, today), week: s.slice(-7).reduce((a, x) => a + x.load, 0) } : null;
  }, [f, runs, today]);
  const [page, setPage] = useState(0);
  const strip = useRef<HTMLDivElement | null>(null);
  const onScroll = () => {
    const el = strip.current;
    if (el) setPage(Math.round(el.scrollLeft / el.clientWidth));
  };
  const go = (i: number) => strip.current?.scrollTo({ left: i * strip.current.clientWidth, behavior: "smooth" });
  const week = rows.filter((r) => r.date > addDays(today, -7));

  return (
    <div className="hp">
      <div className="hp-strip" ref={strip} onScroll={onScroll} data-noswipe>
        {/* 1: readiness and last night */}
        <button type="button" className="hp-page" onClick={() => nav.push("health")}>
          <span className="p-eyebrow">Readiness</span>
          <div className="hp-top">
            {ready ? <Ring value={ready.score} tone={toneFor(ready.score)} size={78} stroke={8} /> : <span className="hp-wait">Waiting for last night's sleep</span>}
            <span className="hp-lead">
              <b>{ready ? ready.level.replace(/^\w/, (c) => c.toUpperCase()) : "–"}</b>
              <small>{night?.readiness_note ?? (ready && !ready.garmin ? "From your sleep, heart rate and training" : "")}</small>
            </span>
          </div>
          <div className="hp-stats">
            <Stat label="Sleep" value={night?.sleep_secs ? hm(night.sleep_secs) : "–"} sub={night?.sleep_score ? `score ${night.sleep_score}` : ""} />
            <Stat label="HRV" value={last.hrv ? `${Math.round(last.hrv)}` : "–"} unit="ms" sub={last.hrv_status ? last.hrv_status.toLowerCase().replace(/_/g, " ") : last.hrv_week ? `week ${Math.round(last.hrv_week)}` : ""} />
            <Stat label="Resting HR" value={last.rhr ? `${Math.round(last.rhr)}` : "–"} unit="bpm" sub={trendWord(rows, "rhr", true)} />
            <Stat label="Body battery" value={last.bb_now ?? last.bb_high ?? "–"} sub={last.bb_high ? `high ${last.bb_high}` : ""} />
          </div>
        </button>

        {/* 2: training load and form */}
        <button type="button" className="hp-page" onClick={() => nav.setTab("stats")}>
          <span className="p-eyebrow">Training</span>
          {load ? (
            <>
              <div className="hp-top">
                <span className={`hp-form f-${load.level}`}>
                  <b className="num">
                    {load.tsb > 0 ? "+" : ""}
                    {Math.round(load.tsb)}
                  </b>
                  <small>form</small>
                </span>
                <span className="hp-lead">
                  <b>{FORM_WORD[load.level]}</b>
                  <small>{load.level === "tired" || load.level === "overload" ? "A lot of recent load: keep the easy days easy" : load.level === "fresh" ? "Rested: a good day for a hard session" : "Training and recovery in balance"}</small>
                </span>
              </div>
              <div className="hp-stats">
                <Stat label="Fitness" value={Math.round(load.ctl)} sub="6-week load" />
                <Stat label="Fatigue" value={Math.round(load.atl)} sub="1-week load" />
                <Stat label="Week load" value={Math.round(load.week)} sub="TRIMP" />
                <Stat label="VO2 max" value={last.vo2 ? Math.round(last.vo2) : f?.current ? f.current.toFixed(1) : "–"} sub={last.vo2 ? "Garmin" : "from runs"} />
              </div>
            </>
          ) : (
            <span className="hp-wait">Runs with heart rate show your training load here.</span>
          )}
        </button>

        {/* 3: the last 7 days */}
        <button type="button" className="hp-page" onClick={() => nav.push("health")}>
          <span className="p-eyebrow">Last 7 days</span>
          <div className="hp-trends">
            <Spark label="Sleep" rows={week} field="sleep_secs" fmt={(v) => hm(v)} />
            <Spark label="HRV" rows={week} field="hrv" fmt={(v) => `${Math.round(v)} ms`} />
            <Spark label="Resting HR" rows={week} field="rhr" fmt={(v) => `${Math.round(v)} bpm`} lowGood />
            <Spark label="Readiness" rows={week} field="readiness" fmt={(v) => `${Math.round(v)}`} />
          </div>
        </button>
      </div>
      <div className="hp-dots" role="tablist" aria-label="Health pages">
        {["Readiness", "Training", "Last 7 days"].map((l, i) => (
          <button key={l} role="tab" aria-selected={page === i} aria-label={l} className={page === i ? "on" : ""} onClick={() => go(i)} />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, unit, sub }: { label: string; value: string | number; unit?: string; sub?: string }) {
  return (
    <span className="hp-stat">
      <small>{label}</small>
      <b className="num">
        {value}
        {unit && value !== "–" ? <i> {unit}</i> : null}
      </b>
      {sub ? <em>{sub}</em> : null}
    </span>
  );
}

function trendWord(rows: HealthDay[], field: "rhr", lowGood: boolean) {
  const xs = rows.map((r) => r[field]).filter((v): v is number => v != null);
  if (xs.length < 6) return "";
  const recent = xs.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const before = xs.slice(0, -3).reduce((a, b) => a + b, 0) / (xs.length - 3);
  const d = recent - before;
  if (Math.abs(d) < 1) return "steady";
  return (d < 0) === lowGood ? "better than usual" : "higher than usual";
}

/** A little bar per day for the last week, with the latest value. */
function Spark({ label, rows, field, fmt, lowGood }: { label: string; rows: HealthDay[]; field: "sleep_secs" | "hrv" | "rhr" | "readiness"; fmt: (v: number) => string; lowGood?: boolean }) {
  const xs = rows.map((r) => ({ date: r.date, v: r[field] }));
  const vals = xs.map((x) => x.v).filter((v): v is number => v != null);
  if (!vals.length)
    return (
      <span className="hp-spark">
        <small>{label}</small>
        <em>–</em>
      </span>
    );
  const lo = Math.min(...vals) * 0.9;
  const hi = Math.max(...vals);
  const lastV = vals[vals.length - 1];
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return (
    <span className="hp-spark">
      <small>{label}</small>
      <span className="hp-bars" aria-hidden="true">
        {xs.map((x) => (
          <i
            key={x.date}
            title={parseKey(x.date).toLocaleDateString("en-GB", { weekday: "short" })}
            className={x.v == null ? "none" : (x.v >= avg) !== !!lowGood ? "good" : ""}
            style={{ height: x.v == null ? "8%" : `${Math.max(10, ((x.v - lo) / Math.max(1, hi - lo)) * 100)}%` }}
          />
        ))}
      </span>
      <em className="num">{fmt(lastV)}</em>
    </span>
  );
}
