import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey } from "../core/time";
import { useQuery } from "../core/useQuery";
import { loadHealth } from "../modules/health/data";
import { ownReadiness } from "../modules/health/readiness";
import { loadFitnessConfig } from "../modules/running/fitness";
import { loadRuns } from "../modules/running/strava";
import { trimp } from "../modules/running/vo2";

/** Where the phone is: a bottom tab, optionally with a page pushed on top (Health, Fitness). */
export type Tab = "today" | "planner" | "training" | "runs" | "stats";
export type Pushed = "health" | "fitness" | "plan" | "adjust" | "pbs" | "calendar" | "tasks" | "habits" | "settings" | "watch" | "weather" | "workout" | "analysis" | null;
export const PhoneNav = createContext<{ tab: Tab; pushed?: Pushed; setTab: (t: Tab) => void; push: (p: Pushed) => void }>({ tab: "today", setTab: () => {}, push: () => {} });
export const usePhoneNav = () => useContext(PhoneNav);

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const shortDate = (d: string) => `${DOW[parseKey(d).getDay()]} ${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
export const dayName = (d: string, today: string) => (d === today ? "Today" : d === addDays(today, 1) ? "Tomorrow" : d === addDays(today, -1) ? "Yesterday" : shortDate(d));

/** A titled group of rows or content, iOS style. */
export function Section({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={"p-section " + className}>
      {(title || action) && (
        <div className="p-section-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      <div className="p-group">{children}</div>
    </section>
  );
}

/** Readiness for today, as on the Health tab (Garmin's if it gave one, else worked out here). */
export function useReadiness(today: string) {
  const hv = useDataVersion("health");
  const rv = useDataVersion("running");
  return useQuery(async () => {
    const [rows, runs, cfg] = await Promise.all([loadHealth(60), loadRuns(addDays(today, -60)), loadFitnessConfig()]);
    const t = rows.find((r) => r.date === today);
    if (t?.readiness != null) return { score: Math.round(t.readiness), level: (t.readiness_level ?? "").toLowerCase().replace(/_/g, " "), garmin: true, sleep: t.sleep_secs, hrv: t.hrv };
    const own = ownReadiness(
      rows,
      today,
      runs.map((r) => ({ date: r.date, load: trimp(r.moving_time, r.avg_hr, cfg) })),
    );
    return own ? { score: own.score, level: own.level, garmin: false, sleep: t?.sleep_secs ?? null, hrv: t?.hrv ?? null } : null;
  }, [hv, rv, today]).data;
}

/** A ring that fills to `value` out of 100. */
export function Ring({ value, size = 64, stroke = 7, tone }: { value: number; size?: number; stroke?: number; tone: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className={"p-ring " + tone} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} className="p-ring-track" strokeWidth={stroke} fill="none" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="p-ring-fill"
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={c}
        style={{ ["--c" as string]: c }}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(100, value)) / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        strokeLinecap="round"
      />
      <text x="50%" y="50%" dy="0.35em" textAnchor="middle" className="p-ring-text">
        {Math.round(value)}
      </text>
    </svg>
  );
}

export const toneFor = (score: number) => (score >= 75 ? "good" : score >= 50 ? "ok" : "low");

/** A sheet that slides up from the bottom. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="p-sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="p-sheet" role="dialog" aria-label={title}>
        <div className="p-sheet-grip" />
        <div className="p-sheet-head">
          <h3>{title}</h3>
          <button className="p-link" onClick={onClose}>
            Done
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** A number that counts up to its value when it first appears (and glides when it changes). */
export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    const a = from.current;
    const ms = 750;
    let raf = 0;
    const tick = (t: number) => {
      const f = Math.min(1, (t - start) / ms);
      const v = a + (value - a) * (1 - Math.pow(1 - f, 3));
      from.current = v;
      setShown(v);
      if (f < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toFixed(decimals)}</>;
}
const reducedMotion = () => !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
