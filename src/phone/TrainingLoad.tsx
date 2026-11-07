import { useMemo, useState } from "react";
import { addDays, parseKey, useToday } from "../core/time";
import { useFitness } from "../modules/running/fitness";
import { dailyLoad, easyShare, FORM_TEXT, formLevel, loadSeries, monotony, ZONES, zoneMinutes } from "../modules/running/runalyze";
import { useRunningData } from "../modules/running/useRunning";
import { Section } from "./common";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RANGES = [
  { id: 42, label: "6 wk" },
  { id: 90, label: "3 mo" },
  { id: 180, label: "6 mo" },
  { id: 365, label: "1 yr" },
] as const;

/** Runalyze's training-load page on the phone: fitness, fatigue, form, monotony and heart-rate zones. */
export function TrainingLoad() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const [days, setDays] = useState<number>(90);
  const [pick, setPick] = useState<number | null>(null);
  const hr = f?.config;
  const d = useMemo(() => {
    if (!hr) return null;
    const daily = dailyLoad(runs, hr);
    const series = loadSeries(daily, addDays(today, -(days - 1)), today);
    return { daily, series, mono: monotony(daily, today), zones4: zoneMinutes(runs, hr, addDays(today, -27)) };
  }, [hr, runs, today, days]);
  if (!d || !d.series.length) return null;
  const { series, mono, zones4 } = d;
  const at = series[pick ?? series.length - 1];
  const level = formLevel(at);
  const W = 320;
  const H = 130;
  const top = Math.max(10, ...series.map((p) => Math.max(p.ctl, p.atl)));
  const tsbMax = Math.max(5, ...series.map((p) => Math.abs(p.tsb)));
  const x = (i: number) => (i / Math.max(1, series.length - 1)) * W;
  const y = (v: number) => H - 6 - (v / top) * (H - 16);
  const path = (k: "ctl" | "atl") => series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k]).toFixed(1)}`).join("");
  const bw = Math.max(1, W / series.length - 0.6);
  const months = series.filter((p, i) => i === 0 || parseKey(p.date).getDate() === 1).map((p) => ({ i: series.indexOf(p), label: MON[parseKey(p.date).getMonth()] }));
  const share = easyShare(zones4);
  const zoneAll = zones4.reduce((a, z) => a + z.minutes, 0);
  const monoTone = mono.monotony == null ? (mono.week > 0 ? "warn" : "") : mono.monotony > 2 ? "warn" : mono.monotony > 1.5 ? "amber" : "good";
  const move = (clientX: number, el: Element) => {
    const r = el.getBoundingClientRect();
    setPick(Math.max(0, Math.min(series.length - 1, Math.round(((clientX - r.left) / r.width) * (series.length - 1)))));
  };
  return (
    <>
      <Section title="Training load">
        <div className="tl">
          <div className="tl-tiles">
            <span className="tl-tile ctl">
              <small>Fitness</small>
              <b className="num">{Math.round(at.ctl)}</b>
            </span>
            <span className="tl-tile atl">
              <small>Fatigue</small>
              <b className="num">{Math.round(at.atl)}</b>
            </span>
            <span className={`tl-tile tsb f-${level}`}>
              <small>Form</small>
              <b className="num">
                {at.tsb > 0 ? "+" : ""}
                {Math.round(at.tsb)}
              </b>
            </span>
          </div>
          <p className={`tl-level f-${level}`}>
            {pick != null && <b>{parseKey(at.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}: </b>}
            {FORM_TEXT[level]}
          </p>
          <svg
            className="tl-chart"
            viewBox={`0 0 ${W} ${H + 46}`}
            data-noswipe
            onTouchStart={(e) => move(e.touches[0].clientX, e.currentTarget)}
            onTouchMove={(e) => move(e.touches[0].clientX, e.currentTarget)}
            onTouchEnd={() => window.setTimeout(() => setPick(null), 1500)}
            onMouseMove={(e) => move(e.clientX, e.currentTarget)}
            onMouseLeave={() => setPick(null)}
            role="img"
            aria-label={`Fitness ${Math.round(at.ctl)}, fatigue ${Math.round(at.atl)}, form ${Math.round(at.tsb)}`}
          >
            <path d={`${path("ctl")}L${W} ${H - 6}L0 ${H - 6}Z`} className="tl-ctl-fill" />
            <path d={path("atl")} className="tl-atl" />
            <path d={path("ctl")} className="tl-ctl" />
            <line x1={0} x2={W} y1={H + 22} y2={H + 22} className="tl-zero" />
            {series.map((p, i) => {
              const h = (Math.abs(p.tsb) / tsbMax) * 20;
              return <rect key={p.date} x={x(i) - bw / 2} width={bw} y={p.tsb >= 0 ? H + 22 - h : H + 22} height={Math.max(0.5, h)} className={p.tsb >= 0 ? "tl-pos" : "tl-neg"} />;
            })}
            {months.map((m) => (
              <text key={m.i} x={Math.min(W - 14, x(m.i) + 2)} y={H + 45} className="tl-mon">
                {m.label}
              </text>
            ))}
            {pick != null && <line x1={x(pick)} x2={x(pick)} y1={0} y2={H + 44} className="tl-cursor" />}
          </svg>
          <div className="tl-foot">
            <span className="tl-key">
              <i className="ctl" /> Fitness <i className="atl" /> Fatigue <i className="tsb" /> Form
            </span>
            <span className="p-seg tl-range">
              {RANGES.map((r) => (
                <button key={r.id} className={days === r.id ? "on" : ""} onClick={() => setDays(r.id)}>
                  {r.label}
                </button>
              ))}
            </span>
          </div>
        </div>
      </Section>

      <Section title="This week">
        <div className="tl-tiles">
          <span className={`tl-tile tone-${monoTone}`}>
            <small>Monotony</small>
            <b className="num">{mono.monotony == null ? (mono.week > 0 ? "high" : "–") : mono.monotony.toFixed(1)}</b>
          </span>
          <span className="tl-tile">
            <small>Strain</small>
            <b className="num">{Math.round(mono.strain)}</b>
          </span>
          <span className="tl-tile">
            <small>Load (TRIMP)</small>
            <b className="num">{Math.round(mono.week)}</b>
          </span>
        </div>
        <p className="p-hint">
          {mono.monotony == null
            ? mono.week > 0
              ? "Every day was much the same: mix harder and easier days (and a rest day) so the body can adapt."
              : "No runs in the last week."
            : mono.monotony > 2
              ? "Very samey: the days are too alike. Easier easy days or a rest day bring it down, and with it the risk of picking something up."
              : mono.monotony > 1.5
                ? "Getting samey: make sure easy days are truly easy."
                : "Good variety between hard, easy and rest days."}
        </p>
      </Section>

      {zoneAll > 0 && (
        <Section title="Heart-rate zones · 4 weeks">
          <div className="tl-zbar" role="img" aria-label="Time in each heart-rate zone">
            {zones4.map((z) => (z.minutes ? <i key={z.zone} className={`hz-${z.zone}`} style={{ flexGrow: z.minutes }} /> : null))}
          </div>
          <div className="tl-zones">
            {zones4.map((z) => {
              const zone = ZONES[z.zone - 1];
              return (
                <span key={z.zone}>
                  <i className={`hz-${z.zone}`} />
                  <b>Z{z.zone}</b> {zone.name}
                  <em className="num">
                    {z.minutes >= 60 ? `${Math.floor(z.minutes / 60)}h ${String(Math.round(z.minutes % 60)).padStart(2, "0")}` : `${Math.round(z.minutes)} min`} · {Math.round((z.minutes / zoneAll) * 100)}%
                  </em>
                </span>
              );
            })}
          </div>
          {share != null && (
            <p className="p-hint">
              {Math.round(share * 100)}% easy (zones 1–2).{" "}
              {share >= 0.75 ? "That's the 80/20 balance most of your running should have." : "Most plans aim for about 80% easy: slow the easy runs down a little."} By each run's average heart rate (max {hr!.hrMax}).
            </p>
          )}
        </Section>
      )}
    </>
  );
}
