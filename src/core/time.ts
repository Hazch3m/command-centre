import { useEffect, useState, useSyncExternalStore } from "react";
import { getSettings, subscribeSettings } from "./settings";

// ---- One shared ticker for the whole app -----------------------------------
// Every clock, countdown and rollover check hangs off this single timer, so
// nothing accumulates intervals over a long day.

type Listener = (now: Date) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule() {
  timer = setTimeout(() => {
    const now = new Date();
    listeners.forEach((l) => l(now));
    if (listeners.size) schedule();
    else timer = null;
  }, 1000 - (Date.now() % 1000) + 5);
}

export function onTick(l: Listener): () => void {
  listeners.add(l);
  if (!timer) schedule();
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Current time, re-rendering once per second or once per minute. */
export function useNow(unit: "second" | "minute" = "minute"): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let last = new Date();
    setNow(last);
    return onTick((t) => {
      // Comparing against the last value (not "seconds === 0") also catches jumps after sleep.
      if (unit === "second" || Math.floor(t.getTime() / 60_000) !== Math.floor(last.getTime() / 60_000)) {
        last = t;
        setNow(t);
      }
    });
  }, [unit]);
  return now;
}

// ---- Day keys ----------------------------------------------------------------
// A "day" runs from the reset hour (default 04:00) to the next reset hour, so
// ticking something off at 01:00 still counts for the evening before.

const pad = (n: number) => String(n).padStart(2, "0");

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayKey(d: Date, resetHour: number): string {
  const shifted = new Date(d);
  if (d.getHours() < resetHour) shifted.setDate(shifted.getDate() - 1);
  return dateKey(shifted);
}

export function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key: string, n: number): string {
  const d = parseKey(key);
  d.setDate(d.getDate() + n);
  return dateKey(d);
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((parseKey(b).getTime() - parseKey(a).getTime()) / 86_400_000);
}

export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Today's day key; re-renders when the day rolls over or the reset hour changes. */
export function useToday(): string {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const now = useNow("minute");
  return dayKey(now, settings.dayResetHour);
}

export function todayKey(): string {
  return dayKey(new Date(), getSettings().dayResetHour);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Today", "Tomorrow", "Yesterday", "Fri", or "Tue 3 Nov". */
export function relativeDayLabel(key: string, today: string): string {
  const diff = diffDays(today, key);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = parseKey(key);
  if (diff > 1 && diff < 7) return WEEKDAYS[d.getDay()];
  const label = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === parseKey(today).getFullYear() ? label : `${label} ${d.getFullYear()}`;
}
