import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { notifyChanged } from "../core/events";
import { flush, phoneState, refresh, unpair } from "../core/backend.phone";
import { RunViewHost } from "../modules/running/RunView";
import { ModulePage } from "../shell/Dashboard";
import { NavContext } from "../shell/nav";
import { Calendar } from "./Calendar";
import { PhoneNav, type Pushed, type Tab } from "./common";
import { Habits } from "./Habits";
import { Tasks } from "./Tasks";
import { Today } from "./Today";
import { Training } from "./Training";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "training", label: "Training", icon: "M13 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0M6 20l3-6 3 2v5M9 14l2-5 4 2 3 3M11 9l-3 1-2 3" },
  { id: "calendar", label: "Calendar", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" },
  { id: "tasks", label: "Tasks", icon: "M4 6l2 2 4-4M4 13l2 2 4-4M13 7h7M13 14h7M4 20h16" },
  { id: "habits", label: "Habits", icon: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12l3 3 5-6" },
];
const PUSHED: Record<Exclude<Pushed, null>, { title: string; module: string }> = {
  health: { title: "Health", module: "health" },
  fitness: { title: "Fitness", module: "fitness" },
  plan: { title: "Plan", module: "running" },
};

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

function SyncLine({ onRefresh, busy }: { onRefresh: () => void; busy: boolean }) {
  useSync();
  const made = phoneState.header?.made ? Date.parse(phoneState.header.made) : 0;
  const waiting = phoneState.pending;
  return (
    <button className={"p-sync" + (phoneState.error ? " warn" : "")} onClick={onRefresh}>
      <span className={"sync-dot" + (busy ? " spin" : "")} />
      {phoneState.error ? phoneState.error.replace(/^Offline: /, "Offline · ") : made ? `Updated ${ago(made)}` : "Not synced yet"}
      {waiting ? ` · ${waiting} to send` : ""}
    </button>
  );
}

export function PhoneApp() {
  const [tab, setTabState] = useState<Tab>(() => (sessionStorage.getItem("cc-phone-tab") as Tab) || "today");
  const [pushed, setPushed] = useState<Pushed>(null);
  const [busy, setBusy] = useState(false);
  const setTab = (t: Tab) => {
    setPushed(null);
    setTabState(t);
    sessionStorage.setItem("cc-phone-tab", t);
    window.scrollTo({ top: 0 });
  };
  const push = (p: Pushed) => {
    setPushed(p);
    window.scrollTo({ top: 0 });
  };
  const phoneNav = useMemo(() => ({ tab, setTab, push }), [tab]);
  // Cards from the PC version link to tabs by module id.
  const cardNav = useMemo(
    () => ({
      tab,
      go: (t: string) => (t === "health" || t === "fitness" ? push(t) : t === "running" ? setTab("training") : t === "checklist" ? setTab("habits") : t === "tasks" || t === "calendar" ? setTab(t) : setTab("today")),
    }),
    [tab],
  );

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

  const title = pushed
    ? PUSHED[pushed].title
    : tab === "today"
      ? new Date().toLocaleDateString("en-GB", { weekday: "long" })
      : TABS.find((t) => t.id === tab)!.label;
  const sub = !pushed && tab === "today" ? new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : null;
  return (
    <PhoneNav.Provider value={phoneNav}>
      <NavContext.Provider value={cardNav}>
        <div className="p-app">
          <header className="p-head">
            {pushed ? (
              <button className="p-back" onClick={() => setPushed(null)}>
                ‹ {TABS.find((t) => t.id === tab)!.label}
              </button>
            ) : (
              <span />
            )}
            <SyncLine onRefresh={() => (flush().catch(() => {}), check())} busy={busy} />
          </header>
          <div className="p-title">
            <h1>{title}</h1>
            {sub && <span>{sub}</span>}
          </div>
          <main className="p-main" key={pushed ?? tab}>
            {pushed ? (
              <div className="p-pushed">
                <ModulePage id={PUSHED[pushed].module} />
              </div>
            ) : tab === "today" ? (
              <>
                <Today />
                <PhoneFooter />
              </>
            ) : tab === "training" ? (
              <Training />
            ) : tab === "calendar" ? (
              <Calendar />
            ) : tab === "tasks" ? (
              <Tasks />
            ) : (
              <Habits />
            )}
          </main>
          <nav className="p-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} className={`p-tab tab-${t.id}` + (tab === t.id ? " on" : "")} onClick={() => setTab(t.id)}>
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
    </PhoneNav.Provider>
  );
}

function PhoneFooter() {
  const [armed, setArmed] = useState(false);
  return (
    <footer className="p-footer">
      <p>Runs, health, the plan and your calendar come from the PC whenever Command Centre is open there. Tasks, habits and plan changes made here are sent back to it.</p>
      <button
        className="p-link danger"
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
