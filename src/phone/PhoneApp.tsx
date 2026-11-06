import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { kvGet, kvSet } from "../core/db";
import { notifyChanged } from "../core/events";
import { REFRESHED_KEY, REFRESH_KEY } from "../core/sync";
import { cloudOn, cloudRun, flush, hasAccount, phoneState, refresh, unpair } from "../core/backend.phone";
import { RunViewHost } from "../modules/running/RunView";
import { loadRuns } from "../modules/running/strava";
import { ModulePage } from "../shell/Dashboard";
import { NavContext } from "../shell/nav";
import { Calendar } from "./Calendar";
import { PhoneNav, type Pushed, type Tab } from "./common";
import { Habits } from "./Habits";
import { PbsTab } from "../modules/running/PbsTab";
import { Runs } from "./Runs";
import { Stats } from "./Stats";
import { AccountSection } from "./Account";
import { PlanAdjustPage } from "./PlanAdjust";
import { Tasks } from "./Tasks";
import { Today } from "./Today";
import { Training } from "./Training";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "training", label: "Plan", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h3M8 17h6" },
  { id: "runs", label: "Runs", icon: "M13 4a2 2 0 1 0 4 0 2 2 0 0 0-4 0M6 20l3-6 3 2v5M9 14l2-5 4 2 3 3M11 9l-3 1-2 3" },
  { id: "stats", label: "Stats", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { id: "more", label: "More", icon: "M5 12h.01M12 12h.01M19 12h.01" },
];
const PUSHED: Record<Exclude<Pushed, null>, { title: string; module: string | null }> = {
  health: { title: "Health", module: "health" },
  fitness: { title: "Fitness", module: "fitness" },
  plan: { title: "Plan", module: "running" },
  adjust: { title: "Your plan", module: null },
  pbs: { title: "Personal bests", module: null },
  calendar: { title: "Calendar", module: null },
  tasks: { title: "Tasks", module: null },
  habits: { title: "Habits", module: null },
};
const PUSHED_PAGE: Partial<Record<Exclude<Pushed, null>, () => ReactNode>> = {
  adjust: () => <PlanAdjustPage />,
  pbs: () => <div className="p-embed"><PbsTab /></div>,
  calendar: () => <Calendar />,
  tasks: () => <Tasks />,
  habits: () => <Habits />,
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
  // The newest of the PC's copy and the cloud's additions to it.
  const made = Math.max(phoneState.header?.made ? Date.parse(phoneState.header.made) : 0, phoneState.header?.cloudMade ? Date.parse(phoneState.header.cloudMade) : 0);
  const stale = !phoneState.header?.cloud && made > 0 && Date.now() - made > 3 * 3600_000;
  const waiting = phoneState.pending;
  return (
    <button className={"p-sync" + (phoneState.error || stale ? " warn" : "")} onClick={onRefresh}>
      <span className={"sync-dot" + (busy ? " spin" : "")} />
      {phoneState.error ? phoneState.error.replace(/^Offline: /, "Offline · ") : made ? `Updated ${ago(made)}${!phoneState.header?.cloud && Date.now() - made > 3 * 3600_000 ? " · is the PC on?" : ""}` : "Not synced yet"}
      {waiting ? ` · ${waiting} to send` : ""}
    </button>
  );
}

export function PhoneApp() {
  const [tab, setTabState] = useState<Tab>(() => {
    const t = sessionStorage.getItem("cc-phone-tab") as Tab | null;
    return t && TABS.some((x) => x.id === t) ? t : "today";
  });
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
      go: (t: string) => (t === "health" || t === "fitness" ? push(t) : t === "running" ? setTab("training") : t === "checklist" ? push("habits") : t === "tasks" || t === "calendar" ? push(t) : setTab("today")),
    }),
    [tab],
  );

  // Refresh: ask the PC to sync Strava, Garmin and the calendar now, then wait for the copy it sends back.
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const askPc = async () => {
    if (asking) return;
    setAsking(true);
    setNote("Asking your PC for the latest runs and data…");
    const stamp = new Date().toISOString();
    const count = async () => {
      try {
        return (await loadRuns("2000-01-01")).length;
      } catch {
        return 0;
      }
    };
    const before = await count();
    let answer = "";
    try {
      if (cloudOn()) {
        // Cloud sync on: the service fetches from Garmin and the calendars itself, PC or no PC.
        setNote("Asking the cloud to check Garmin and your calendars…");
        const r = await cloudRun();
        if (await refresh()) await notifyChanged("*");
        const problems = Object.entries(r?.errors ?? {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
        const n = (await count()) - before;
        answer = (n > 0 ? `${n} new run${n === 1 ? "" : "s"}.` : "Up to date: no new runs yet.") + (problems.length ? ` ${problems.join(" · ")}` : "");
        throw { done: true };
      }
      await kvSet(REFRESH_KEY, stamp);
      await flush();
      const made = phoneState.header?.made ? Date.parse(phoneState.header.made) : 0;
      answer = `Your PC didn't answer${made ? ` (it last sent data ${ago(made)})` : ""}. It's probably asleep, off, or Command Centre is closed; open Command Centre on the PC and it catches up within a minute.`;
      for (const until = Date.now() + 75_000; Date.now() < until; ) {
        await new Promise((r) => window.setTimeout(r, 5000));
        if (await refresh()) await notifyChanged("*");
        if ((await kvGet<string | null>(REFRESHED_KEY, null)) === stamp) {
          const n = (await count()) - before;
          answer = n > 0 ? `${n} new run${n === 1 ? "" : "s"}.` : "Up to date: no new runs yet.";
          break;
        }
        if (phoneState.error) {
          answer = phoneState.error;
          break;
        }
      }
    } catch (e) {
      if (!(e as { done?: boolean })?.done) answer = `Couldn't ${cloudOn() ? "ask the cloud" : "ask the PC"}: ${String((e as Error)?.message ?? e)}`;
    }
    setNote(answer);
    setAsking(false);
    window.setTimeout(() => setNote((x) => (x === answer ? null : x)), 8000);
  };

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
            <span className="p-head-right">
              <SyncLine onRefresh={askPc} busy={busy || asking} />
              <button className={"p-refresh" + (asking ? " spin" : "")} onClick={askPc} disabled={asking} aria-label="Refresh">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </span>
          </header>
          {note && (
            <div className="p-note" role="status" onClick={() => setNote(null)}>
              {asking && <span className="sync-dot spin" />}
              {note}
            </div>
          )}
          <div className="p-title">
            <h1>{title}</h1>
            {sub && <span>{sub}</span>}
          </div>
          <main className="p-main" key={pushed ?? tab}>
            {pushed ? (
              <div className="p-pushed">
                {PUSHED[pushed].module ? <ModulePage id={PUSHED[pushed].module!} /> : PUSHED_PAGE[pushed]!()}
              </div>
            ) : tab === "today" ? (
              <Today />
            ) : tab === "training" ? (
              <Training />
            ) : tab === "runs" ? (
              <Runs />
            ) : tab === "stats" ? (
              <Stats />
            ) : (
              <More push={push} />
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

function More({ push }: { push: (p: Pushed) => void }) {
  const rows: [Exclude<Pushed, null>, string, string][] = [
    ["calendar", "Calendar", "Your events and the plan's sessions"],
    ["tasks", "Tasks", "To-dos and projects"],
    ["habits", "Habits", "Daily checklist and streaks"],
    ["adjust", "Your plan and races", "Build a plan, races and tapers, import a CSV"],
  ];
  return (
    <div className="p-screen">
      <section className="p-section">
        <div className="p-group">
          {rows.map(([id, title, sub]) => (
            <button key={id} className="p-row p-row-btn" onClick={() => push(id)}>
              <span className="p-row-main">
                <span className="p-row-title">{title}</span>
                <span className="p-row-sub">{sub}</span>
              </span>
              <span className="p-chev">›</span>
            </button>
          ))}
        </div>
      </section>
      <AccountSection />
      {!hasAccount() && <PhoneFooter />}
    </div>
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
