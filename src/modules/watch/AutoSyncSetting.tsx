import { useEffect, useState } from "react";
import { notifyChanged } from "../../core/events";
import { cloudRunNow, getPhoneStatus, pullCloudChanges, pushSnapshot } from "../../core/phoneSync";
import { onPhone } from "../../core/platform";
import { getAutoSync, getAutoSyncState, runAutoSync, setAutoSync, stopAutoSync, type AutoSyncSettings, type AutoSyncState } from "./autoSync";

/** One watch sync: in the cloud when cloud sync is on (after sending it the latest plan), else here. */
export async function syncWatchNow(): Promise<void> {
  const st = await getPhoneStatus().catch(() => null);
  if (st?.cloud) {
    await pushSnapshot().catch(() => {});
    await cloudRunNow();
    await pullCloudChanges();
  } else await runAutoSync();
  await notifyChanged("watch");
}

/**
 * Keeps the watch in step with the plan: soon after any plan change, every
 * 30 minutes, and when switched on. With cloud sync on, the cloud does it
 * (also every 15 minutes with the PC off).
 */
export function useWatchAutoSync() {
  useEffect(() => {
    if (onPhone) return;
    let t: number | undefined;
    let alive = true;
    const go = async () => {
      if (!alive || !(await getAutoSync()).on) return;
      await syncWatchNow().catch(() => {});
    };
    const soon = (ms: number) => () => {
      window.clearTimeout(t);
      t = window.setTimeout(go, ms);
    };
    const onPlan = soon(20_000);
    const onToggle = soon(300);
    t = window.setTimeout(go, 30_000);
    const iv = window.setInterval(go, 30 * 60_000);
    window.addEventListener("cc:plan-changed", onPlan);
    window.addEventListener("cc:watch-sync", onToggle);
    return () => {
      alive = false;
      window.clearTimeout(t);
      window.clearInterval(iv);
      window.removeEventListener("cc:plan-changed", onPlan);
      window.removeEventListener("cc:watch-sync", onToggle);
    };
  }, []);
}

const DAYS = [3, 7, 14];

/** "Keep my watch in sync with the plan": switch, how far ahead, and what it last did. */
export function AutoSyncSetting() {
  const [s, setS] = useState<AutoSyncSettings | null>(null);
  const [st, setSt] = useState<AutoSyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const reload = async () => {
    setS(await getAutoSync());
    setSt(await getAutoSyncState());
  };
  useEffect(() => {
    reload();
    const iv = window.setInterval(reload, 10_000);
    return () => window.clearInterval(iv);
  }, []);
  if (!s) return null;
  const save = async (next: AutoSyncSettings) => {
    setS(next);
    await setAutoSync(next);
    if (onPhone) return;
    setBusy(true);
    await syncWatchNow().catch(() => {});
    await reload();
    setBusy(false);
  };
  const synced = Object.keys(st?.days ?? {}).sort();
  return (
    <div className="autosync">
      <div className="autosync-head">
        <div>
          <b>Keep my watch in sync with the plan</b>
          <div className="muted small">
            The next {s.days} days of sessions go on your Garmin calendar as structured workouts, and are updated, moved or removed whenever the plan changes. Workouts you made
            yourself are left alone.
          </div>
        </div>
        <button type="button" className={"toggle" + (s.on ? " on" : "")} role="switch" aria-checked={s.on} disabled={busy} onClick={() => (s.on ? setAsking(true) : save({ ...s, on: true }))}>
          <span />
        </button>
      </div>
      {asking && (
        <div className="autosync-off">
          <span className="small">Switch off. Take the synced workouts off your Garmin calendar too?</span>
          <button
            className="btn"
            onClick={async () => {
              setAsking(false);
              setBusy(true);
              await stopAutoSync(true).catch(() => {});
              await reload();
              setBusy(false);
            }}
          >
            Remove them
          </button>
          <button
            className="btn ghost"
            onClick={async () => {
              setAsking(false);
              await stopAutoSync(false);
              await reload();
            }}
          >
            Leave them
          </button>
        </div>
      )}
      {s.on && (
        <div className="autosync-row">
          <span className="label">Days ahead</span>
          <span className="segmented small-seg">
            {DAYS.map((d) => (
              <button key={d} className={s.days === d ? "on" : ""} onClick={() => save({ ...s, days: d })}>
                {d}
              </button>
            ))}
          </span>
          {!onPhone && (
            <button
              className="btn ghost small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await syncWatchNow().catch(() => {});
                await reload();
                setBusy(false);
              }}
            >
              {busy ? "Syncing…" : "Sync now"}
            </button>
          )}
        </div>
      )}
      {st?.lastRun && (
        <div className="small muted">
          Last sync {new Date(st.lastRun).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}: {st.lastError ? <span className="tone-warn">{st.lastError}</span> : st.lastResult}
          {synced.length > 0 && ` · on the watch: ${synced.length} day${synced.length === 1 ? "" : "s"} (${synced.map((d) => d.slice(8)).join(", ")})`}
        </div>
      )}
      {onPhone && s.on && <div className="small muted">Changes made here take effect once the PC (or the cloud) next syncs.</div>}
    </div>
  );
}
