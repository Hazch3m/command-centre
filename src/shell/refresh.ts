import { useEffect, useState } from "react";
import { kvGet, kvSet } from "../core/db";
import { notifyChanged } from "../core/events";
import { pushSnapshot } from "../core/phoneSync";
import { REFRESHED_KEY, REFRESH_KEY } from "../core/sync";
import { syncCalendar } from "../modules/calendar/data";
import { syncHealth } from "../modules/health/data";
import { loadRuns, syncRuns } from "../modules/running/strava";
import { refreshWeather } from "../modules/weather/index";

export interface RefreshResult {
  newRuns: number;
  problems: string[];
}

let running: Promise<RefreshResult> | null = null;

const runCount = async () => {
  try {
    return (await loadRuns("2000-01-01")).length;
  } catch {
    return 0;
  }
};

/**
 * Pulls everything fresh now: runs (Garmin, or Strava), Garmin health, calendars and the
 * weather, then redraws every card and sends the phone a new copy. One at a
 * time; a second press while it runs waits for the same one.
 */
export function refreshAll(beforePush?: () => Promise<void>): Promise<RefreshResult> {
  running ??= (async () => {
    const before = await runCount();
    const jobs: [string, Promise<unknown>][] = [
      ["Runs", syncRuns().then((s) => (s.lastError ? Promise.reject(new Error(s.lastError)) : s))],
      ["Garmin", syncHealth()],
      ["Calendar", syncCalendar().then((s) => (s.error ? Promise.reject(new Error(s.error)) : s))],
      ["Weather", refreshWeather()],
    ];
    const done = await Promise.allSettled(jobs.map(([, p]) => p));
    const problems = done.flatMap((r, i) => (r.status === "rejected" && !/offline|not connected/i.test(String(r.reason)) ? [`${jobs[i][0]}: ${String((r.reason as Error)?.message ?? r.reason)}`] : []));
    await notifyChanged("*");
    window.dispatchEvent(new Event("cc:plan-changed"));
    await beforePush?.().catch(() => {});
    pushSnapshot().catch(() => {});
    return { newRuns: Math.max(0, (await runCount()) - before), problems };
  })().finally(() => (running = null));
  return running;
}

export function refreshMessage(r: RefreshResult): string {
  const runs = r.newRuns ? `${r.newRuns} new run${r.newRuns === 1 ? "" : "s"}` : "Up to date: no new runs";
  return r.problems.length ? `${runs}. ${r.problems.join(" · ")}` : `${runs}.`;
}

/** The refresh button's state, shared by the header button and the F5 / Ctrl+R shortcut. */
export function useRefresh(onDone: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(refreshMessage(await refreshAll()));
    } catch (e) {
      onDone(`Refresh failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "F5" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r" && !e.shiftKey)) {
        e.preventDefault();
        go();
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return { busy, go };
}

/**
 * Runs (Garmin, and Strava if it still works) every 5 minutes and whenever the window comes back into focus (at
 * most every 2 minutes), so a run shows up soon after your watch syncs; and
 * a full refresh when the phone asks for one.
 */
export function useAutoRefresh() {
  useEffect(() => {
    let last = 0;
    const strava = () => {
      if (Date.now() - last < 2 * 60_000) return;
      last = Date.now();
      syncRuns().catch(() => {});
    };
    strava();
    const iv = window.setInterval(strava, 5 * 60_000);
    window.addEventListener("focus", strava);
    // The phone's stamp goes back with the copy, so the phone knows this copy answers its request.
    const asked = async () => {
      const stamp = await kvGet<string | null>(REFRESH_KEY, null);
      await refreshAll(() => kvSet(REFRESHED_KEY, stamp)).catch(() => {});
    };
    window.addEventListener("cc:refresh-request", asked);
    return () => {
      window.clearInterval(iv);
      window.removeEventListener("focus", strava);
      window.removeEventListener("cc:refresh-request", asked);
    };
  }, []);
}
