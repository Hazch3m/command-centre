import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { notifyChanged } from "../core/events";
import { flush, phoneState, refresh, unpair } from "../core/backend.phone";
import { moduleById } from "../modules/registry";
import { RunViewHost } from "../modules/running/RunView";
import { ModulePage } from "../shell/Dashboard";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import { NavContext } from "../shell/nav";

/** The phone's tabs, left to right along the bottom. */
const TABS: { id: string; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "running", label: "Training", icon: "M13 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0M6 20l3-6 3 2v5M9 14l2-5 4 2 3 3M11 9l-3 1-2 3" },
  { id: "fitness", label: "Fitness", icon: "M3 17l5-5 4 4 8-9M15 7h5v5" },
  { id: "health", label: "Health", icon: "M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" },
  { id: "calendar", label: "Calendar", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" },
  { id: "tasks", label: "Tasks", icon: "M4 6l2 2 4-4M4 13l2 2 4-4M13 7h7M13 14h7M4 20h16" },
  { id: "checklist", label: "Habits", icon: "M5 12l4 4 10-10M5 20h14" },
];

/** Today: the key cards from the PC's overview, one under another. */
const TODAY = ["running", "health", "checklist", "tasks", "calendar", "training-week", "predictions", "weather", "fitness"];

function useSync() {
  return useSyncExternalStore(
    (cb) => phoneState.onChange(cb),
    () => `${phoneState.version}|${phoneState.pending}|${phoneState.error}|${phoneState.lastCheck}`,
  );
}

const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

function SyncChip({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  useSync();
  const made = phoneState.header?.made ? Date.parse(phoneState.header.made) : phoneState.version;
  const waiting = phoneState.pending;
  return (
    <button className={"sync-chip" + (phoneState.error ? " warn" : "")} onClick={onRefresh} title={phoneState.error ?? "Check for a newer copy from the PC"}>
      <span className={"sync-dot" + (busy ? " spin" : "")} />
      {phoneState.error ? phoneState.error.replace(/^Offline: /, "Offline · ") : made ? `PC data ${ago(made)}` : "Not synced yet"}
      {waiting ? ` · ${waiting} change${waiting > 1 ? "s" : ""} to send` : ""}
    </button>
  );
}

export function PhoneApp() {
  const [tab, setTab] = useState(() => sessionStorage.getItem("cc-phone-tab") ?? "today");
  const [busy, setBusy] = useState(false);
  const go = (t: string) => {
    const next = t === "overview" ? "today" : t;
    setTab(next);
    sessionStorage.setItem("cc-phone-tab", next);
    window.scrollTo({ top: 0 });
  };
  const nav = useMemo(() => ({ tab, go }), [tab]);

  const check = async () => {
    setBusy(true);
    try {
      if (await refresh()) await notifyChanged("*");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    check();
    const iv = window.setInterval(check, 2 * 60_000);
    const vis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", vis);
    window.addEventListener("online", vis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", vis);
      window.removeEventListener("online", vis);
    };
  }, []);

  const title = tab === "today" ? new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : TABS.find((t) => t.id === tab)?.label;
  return (
    <NavContext.Provider value={nav}>
      <div className="phone-app">
        <header className="phone-top">
          <h1>{title}</h1>
          <SyncChip onRefresh={() => (flush().catch(() => {}), check())} busy={busy} />
        </header>
        <main className="phone-main" key={tab}>
          {tab === "today" ? (
            <div className="phone-today">
              {TODAY.map((id) => {
                const m = moduleById.get(id);
                if (!m) return null;
                return (
                  <div key={id} className={`card card-${id}`}>
                    <div className="card-body">
                      <ErrorBoundary name={m.title}>
                        <m.Card editing={false} variant="tile" />
                      </ErrorBoundary>
                    </div>
                  </div>
                );
              })}
              <PhoneFooter />
            </div>
          ) : (
            <ModulePage id={tab} />
          )}
        </main>
        <nav className="phone-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`phone-tab tab-${t.id}` + (tab === t.id ? " on" : "")} onClick={() => go(t.id)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={t.icon} />
              </svg>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <RunViewHost />
      </div>
    </NavContext.Provider>
  );
}

function PhoneFooter() {
  const [armed, setArmed] = useState(false);
  return (
    <footer className="phone-footer muted small">
      <p>Runs, health, calendar and the plan update from your PC whenever Command Centre is open there. Tasks, habits and plan changes you make here are sent to it.</p>
      <button
        className="btn ghost"
        onClick={async () => {
          if (!armed) {
            setArmed(true);
            window.setTimeout(() => setArmed(false), 4000);
            return;
          }
          await unpair();
          location.reload();
        }}
      >
        {armed ? "Tap again to unlink this phone" : "Unlink this phone"}
      </button>
    </footer>
  );
}
