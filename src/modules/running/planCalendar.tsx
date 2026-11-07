import { useEffect, useState } from "react";
import { kvGet, kvSet } from "../../core/db";
import { useDataVersion } from "../../core/events";
import { addDays, todayKey } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { ErrorNote } from "../../shell/ui";
import { calendarSources, getCalendars, googleWrite, GOOGLE_CAL_API, syncCalendar } from "../calendar/data";
import { forecastWeek, type ForecastDay } from "./forecast";
import { loadPlan, mondayOf } from "./plan";
import { loadOverrides } from "./strava";

/**
 * Puts the training plan into a Google calendar as all-day events, one per
 * planned day, and keeps them in step: change the plan or a day and the event
 * is updated; remove a day and its event goes. Only events this app made are
 * touched (they're remembered by date in `plan.gcal.map`).
 */

export interface PlanCalSettings {
  enabled: boolean;
  calendarId: string | null;
  weeks: number;
  lastSync: string | null;
  error: string | null;
}
const DEFAULTS: PlanCalSettings = { enabled: false, calendarId: null, weeks: 8, lastSync: null, error: null };
type MapEntry = { id: string; hash: string; cal: string };

export const getPlanCalSettings = async () => ({ ...DEFAULTS, ...(await kvGet<Partial<PlanCalSettings>>("plan.gcal", {})) });
const setSettings = async (s: Partial<PlanCalSettings>) => kvSet("plan.gcal", { ...(await getPlanCalSettings()), ...s });

/** What goes in the calendar for one planned day, or null for nothing. */
export function eventFor(d: ForecastDay): { summary: string; description: string } | null {
  const strength = d.strength ? `Strength ${d.strength}` : "";
  if (d.race) return { summary: `🏁 ${d.race.name}${d.race.target ? ` (${d.race.target})` : ""}`, description: [d.text, d.race.role].filter(Boolean).join("\n") };
  if (d.kind === "rest" || d.kind === "optional" || !d.text) return strength ? { summary: `💪 ${strength}`, description: "" } : null;
  const km = d.km != null ? ` · ≈${Math.round(d.km)} km` : "";
  const icon = d.kind === "key" ? "⚡" : d.kind === "long" ? "🛣️" : "🏃";
  const short = d.text.length > 60 ? `${d.text.slice(0, 57)}…` : d.text;
  return {
    summary: `${icon} ${short}${km}`,
    description: [d.text, d.pace ? `Pace: ${d.pace}` : "", strength, d.edited ? "(changed in Pacelife)" : "", "Added by Pacelife from your training plan."].filter(Boolean).join("\n"),
  };
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
};

let running: Promise<string> | null = null;

/** Creates, updates and deletes the plan's events. Returns a one-line summary. */
export function syncPlanToCalendar(): Promise<string> {
  if (!running) running = doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<string> {
  const s = await getPlanCalSettings();
  if (!s.enabled || !s.calendarId) return "Off";
  const { google } = await calendarSources();
  if (!google) {
    await setSettings({ error: "Google isn't connected (Settings → Connections)." });
    return "Google not connected";
  }
  try {
    const { plan } = await loadPlan();
    const overrides = await loadOverrides();
    const today = todayKey();
    const first = mondayOf(today);
    const want = new Map<string, { summary: string; description: string }>();
    for (let w = 0; w < s.weeks; w++) {
      for (const d of forecastWeek(plan, addDays(first, 7 * w), [], overrides).days) {
        if (d.date < today) continue;
        const e = eventFor(d);
        if (e) want.set(d.date, e);
      }
    }
    const map = await kvGet<Record<string, MapEntry>>("plan.gcal.map", {});
    const base = `${GOOGLE_CAL_API}/calendars/${encodeURIComponent(s.calendarId)}/events`;
    let made = 0,
      changed = 0,
      removed = 0;
    const save = () => kvSet("plan.gcal.map", map);

    // Past days stay as a record; future days no longer planned (or on another calendar) go.
    for (const [date, m] of Object.entries(map)) {
      if (date < today) continue;
      if (want.has(date) && m.cal === s.calendarId) continue;
      await googleWrite("DELETE", `${GOOGLE_CAL_API}/calendars/${encodeURIComponent(m.cal)}/events/${encodeURIComponent(m.id)}`).catch((e) => {
        if (!/404|410|deleted/i.test(String(e))) throw e;
      });
      delete map[date];
      removed++;
      await save();
    }
    for (const [date, e] of want) {
      const h = hash(e.summary + "\n" + e.description);
      const body = {
        summary: e.summary,
        description: e.description,
        start: { date },
        end: { date: addDays(date, 1) },
        transparency: "transparent", // doesn't show you as busy
        extendedProperties: { private: { commandCentre: "plan", date } },
      };
      const m = map[date];
      if (m && m.hash === h) continue;
      if (m) {
        try {
          await googleWrite("PATCH", `${base}/${encodeURIComponent(m.id)}`, body);
          map[date] = { ...m, hash: h };
          changed++;
          await save();
          continue;
        } catch (err) {
          // Deleted by hand in Google: make it again.
          if (!/404|410|not found|deleted/i.test(String(err))) throw err;
        }
      }
      const out = (await googleWrite("POST", base, body)) as unknown as { id: string };
      map[date] = { id: out.id, hash: h, cal: s.calendarId };
      made++;
      await save();
    }
    await setSettings({ lastSync: new Date().toISOString(), error: null });
    if (made || changed || removed) await syncCalendar().catch(() => {});
    return `${made} added, ${changed} updated, ${removed} removed`;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await setSettings({ error: msg });
    throw e;
  }
}

/** Removes every future event this app made (when switching the sync off). */
async function removeAll() {
  const map = await kvGet<Record<string, MapEntry>>("plan.gcal.map", {});
  const today = todayKey();
  for (const [date, m] of Object.entries(map)) {
    if (date < today) continue;
    await googleWrite("DELETE", `${GOOGLE_CAL_API}/calendars/${encodeURIComponent(m.cal)}/events/${encodeURIComponent(m.id)}`).catch(() => {});
    delete map[date];
  }
  await kvSet("plan.gcal.map", map);
  await syncCalendar().catch(() => {});
}

/**
 * Keeps the calendar in step in the background: after plan edits, day edits
 * (overrides) and once an hour. Mounted once by the dashboard.
 */
export function usePlanCalendarSync() {
  const version = useDataVersion("running");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("cc:plan-changed", bump);
    const iv = window.setInterval(bump, 60 * 60_000);
    return () => {
      window.removeEventListener("cc:plan-changed", bump);
      window.clearInterval(iv);
    };
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => syncPlanToCalendar().catch(() => {}), 4000);
    return () => window.clearTimeout(t);
  }, [version, tick]);
}

/** The settings block on the plan editor. */
export function PlanCalendarSync() {
  const [v, setV] = useState(0);
  const settings = useQuery(getPlanCalSettings, [v]);
  const sources = useQuery(calendarSources, []);
  const cals = useQuery(getCalendars, [v]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const s = settings.data;
  if (!s) return null;
  const writable = (cals.data ?? []).filter((c) => c.writable);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      const out = await fn();
      if (typeof out === "string") setMsg(out);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      setV((x) => x + 1);
    }
  };

  return (
    <section className="plan-gcal">
      <h3>Put the plan in my Google Calendar</h3>
      {sources.data && !sources.data.google ? (
        <p className="muted small">
          This needs Google signed in (Settings → Connections → Google Calendar → Connect). A secret iCal address only lets the app read your calendar, not add to it.
        </p>
      ) : !writable.length ? (
        <p className="muted small">No calendar you can add to yet. If you've just connected Google, give it a moment to sync; if you connected before this update, Disconnect and Connect again.</p>
      ) : (
        <>
          <p className="muted small">
            Each planned day becomes an all-day event (session, ≈km, pace, strength) that doesn't block your time. Edit the plan or a single day and the events follow within a few seconds.
            Tip: make a separate "Training" calendar in Google so it can be hidden or shared on its own.
          </p>
          <div className="plan-gcal-row">
            <label className="inline">
              <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => {
                const on = e.target.checked;
                run(async () => {
                await setSettings({ enabled: on, calendarId: s.calendarId ?? writable.find((c) => /train|run/i.test(c.name))?.id ?? writable.find((c) => c.primary)?.id ?? writable[0].id });
                if (on) return syncPlanToCalendar();
                await removeAll();
                return "Sync off, the plan's future events were removed.";
                });
              }} />
              Keep in sync
            </label>
            <label className="small">
              Calendar{" "}
              <select value={s.calendarId ?? ""} disabled={busy} onChange={(e) => run(async () => {
                await setSettings({ calendarId: e.target.value });
                return s.enabled ? syncPlanToCalendar() : null;
              })}>
                {!s.calendarId && <option value="">Choose…</option>}
                {writable.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </label>
            <label className="small">
              Ahead{" "}
              <select value={s.weeks} disabled={busy} onChange={(e) => run(async () => {
                await setSettings({ weeks: +e.target.value });
                return s.enabled ? syncPlanToCalendar() : null;
              })}>
                {[2, 4, 8, 12, 26].map((n) => (
                  <option key={n} value={n}>{n} weeks</option>
                ))}
              </select>
            </label>
            {s.enabled && (
              <button className="btn" disabled={busy} onClick={() => run(syncPlanToCalendar)}>
                {busy ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
          <div className="muted small">
            {msg ? `${msg}. ` : ""}
            {s.lastSync && `Last synced ${new Date(s.lastSync).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.`}
          </div>
        </>
      )}
      <ErrorNote error={err ?? s.error} />
    </section>
  );
}
