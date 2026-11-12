import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type PointerEvent as RPointerEvent } from "react";
import { syncAppleHealth } from "../modules/health/appleHealth";
import { saveFocusSource, useFocusSource } from "./Focus";
import { kvGet, kvSet } from "../core/db";
import { notifyChanged } from "../core/events";
import { REFRESHED_KEY, REFRESH_KEY } from "../core/sync";
import { cloudOn, cloudRun, flush, hasAccount, phoneState, refresh, unpair } from "../core/backend.phone";
import { RunViewHost } from "../modules/running/RunView";
import { AutoReview } from "../modules/running/RunReview";
import { PullBeat, usePullRefresh } from "./pullRefresh";
import { resetPageScroll } from "./scroll";
import { loadRuns } from "../modules/running/strava";
import { ModulePage } from "../shell/Dashboard";
import { NavContext } from "../shell/nav";
import { Calendar } from "./Calendar";
import { PhoneNav, usePhoneNav, type Pushed, type Tab } from "./common";
import { Habits } from "./Habits";
import { PbsTab } from "../modules/running/PbsTab";
import { Runs } from "./Runs";
import { Stats } from "./Stats";
import { AccountSection } from "./Account";
import { PlanAdjustPage } from "./PlanAdjust";
import { Tasks } from "./Tasks";
import { Today } from "./Today";
import { WebToday } from "./WebToday";
import { Training } from "./Training";
import { Planner, plannerView } from "./Planner";
import { useSwipe } from "./swipe";
import { plannerShown, setPlannerShown } from "./plannerPref";
import { WorkoutCreator } from "./WorkoutCreator";
import { Analysis } from "../modules/running/Analysis";
import { ACCENTS, phoneLook, setPhoneLook, type PhoneLook } from "../core/appearance";

const ALL_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { id: "planner", label: "Planner", icon: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14l2 2 4-4" },
  { id: "training", label: "Plan", icon: "M4 20h4v-6H4zM10 20h4V10h-4zM16 20h4V5h-4z" },
  { id: "runs", label: "Runs", icon: "M14.5 5.2a1.9 1.9 0 1 0 3.8 0 1.9 1.9 0 1 0-3.8 0M13.6 8.6 11 13.6M13.6 8.6l2.9 2.6 2.6-.9M13.6 8.6l-3.3.9-1.7 2.6M11 13.6l3.4 2.1-1.1 4.6M11 13.6l-2.1 3.4-4.2.9" },
  { id: "stats", label: "Stats", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
];

let TABS = ALL_TABS.filter((t) => t.id !== "planner" || plannerShown());
if (typeof window !== "undefined") window.addEventListener("cc:tabs-changed", () => (TABS = ALL_TABS.filter((t) => t.id !== "planner" || plannerShown())));
/** On a computer the side bar also opens these pages directly. */
const WIDE_EXTRA: { id: Exclude<Pushed, null>; label: string; icon: string }[] = [
  { id: "fitness", label: "Fitness", icon: "M3 12h4l3-8 4 16 3-8h4" },
  { id: "health", label: "Health", icon: "M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" },
  { id: "analysis", label: "Analysis", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
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
  settings: { title: "Settings", module: null },
  workout: { title: "Create a workout", module: null },
  watch: { title: "Watch workouts", module: "watch" },
  weather: { title: "Weather", module: "weather" },
  analysis: { title: "Analysis", module: null },
};
const PUSHED_PAGE: Partial<Record<Exclude<Pushed, null>, () => ReactNode>> = {
  adjust: () => <PlanAdjustPage />,
  analysis: () => (
    <div className="p-wide-page">
      <Analysis />
    </div>
  ),
  pbs: () => <div className="p-embed"><PbsTab /></div>,
  calendar: () => <Calendar />,
  tasks: () => <Tasks />,
  habits: () => <Habits />,
  settings: () => <SettingsPage />,
  workout: () => <WorkoutCreator />,
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

/** The app; `wide` is the same app laid out for a computer (pacelife.run/web): tabs down the side, pages in columns. */
export function PhoneApp({ wide = false }: { wide?: boolean } = {}) {
  // Re-render when the Planner tab is switched on or off.
  const [, setTabsVer] = useState(0);
  useEffect(() => {
    const on = () => setTabsVer((v) => v + 1);
    window.addEventListener("cc:tabs-changed", on);
    return () => window.removeEventListener("cc:tabs-changed", on);
  }, []);
  const [tab, setTabState] = useState<Tab>(() => {
    const t = sessionStorage.getItem("cc-phone-tab") as Tab | null;
    return t && TABS.some((x) => x.id === t) ? t : "today";
  });
  const [pushed, setPushed] = useState<Pushed>(null);
  const [busy, setBusy] = useState(false);
  // Which way the page slides in (a tap on a tab further along; a swipe already moved it).
  const [dir, setDir] = useState<1 | -1 | 0>(0);
  // Tabs stay alive once opened (and the ones either side get ready), so swiping never shows a blank page.
  const [seen, setSeen] = useState<Set<Tab>>(() => new Set([tab]));
  const swiped = useRef(false);
  const setTab = (t: Tab) => {
    const from = TABS.findIndex((x) => x.id === tab);
    const to = TABS.findIndex((x) => x.id === t);
    setDir(swiped.current ? 0 : to > from ? 1 : to < from ? -1 : 0);
    swiped.current = false;
    setSeen((x) => (x.has(t) ? x : new Set([...x, t])));
    setPushed(null);
    setTabState(t);
    sessionStorage.setItem("cc-phone-tab", t);
  };
  // A new page starts at the top: done after it's laid out and before it's drawn, so nothing jumps.
  useLayoutEffect(() => {
    resetPageScroll();
  }, [tab, pushed]);
  const push = (p: Pushed) => {
    setDir(swiped.current ? 0 : p ? 1 : -1);
    swiped.current = false;
    setPushed(p);
    resetPageScroll();
  };
  const phoneNav = useMemo(() => ({ tab, pushed, setTab, push }), [tab, pushed]);
  // The tab bar's lens follows your finger: press, slide along the bar, let go on a tab.
  const tabsRef = useRef<HTMLElement | null>(null);
  const indRef = useRef<HTMLSpanElement | null>(null);
  const drag = useRef<{ id: number; x0: number; moved: boolean; lx: number; lt: number; v: number } | null>(null);
  const slotAt = (x: number) => {
    const nav = tabsRef.current!;
    const ind = indRef.current!;
    const r = nav.getBoundingClientRect();
    const left = ind.offsetLeft;
    const w = ind.offsetWidth;
    const px = Math.max(0, Math.min(r.width - 2 * left - w, x - r.left - left - w / 2));
    return { px, i: Math.max(0, Math.min(TABS.length - 1, Math.floor((x - r.left - left) / w))) };
  };
  // A tap: the lens sets off for the new tab straight away (on the compositor, so it glides even while the
  // page is being built), and the page follows a frame later.
  const tapTab = (t: Tab) => {
    const ind = indRef.current;
    if (wide || !ind) {
      setPushed(null);
      setTab(t);
      return;
    }
    ind.classList.remove("off");
    ind.style.transform = `translateX(${TABS.findIndex((x) => x.id === t) * 100}%)`;
    if (t !== tab) {
      ind.classList.add("moving");
      window.setTimeout(() => ind.classList.remove("moving"), 380);
    }
    requestAnimationFrame(() => {
      setPushed(null);
      setTab(t);
    });
  };
  const tabDrag = {
    // Press: the lens swells and springs to sit under your finger. Slide: it follows your finger exactly,
    // stretching with your speed. Let go: it settles on the tab underneath.
    onPointerDown: (e: RPointerEvent) => {
      const ind = indRef.current;
      if (e.pointerType === "mouse" || !ind || !tabsRef.current) return;
      drag.current = { id: e.pointerId, x0: e.clientX, moved: false, lx: e.clientX, lt: e.timeStamp, v: 0 };
      try {
        tabsRef.current.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer has gone */
      }
      // The lens only swells here; it moves on a drag, or glides once to a tapped tab (no double motion).
      ind.classList.remove("off", "drag");
      ind.classList.add("lift");
    },
    onPointerMove: (e: RPointerEvent) => {
      const d = drag.current;
      const ind = indRef.current;
      if (!d || d.id !== e.pointerId || !ind) return;
      if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
      if (!d.moved) {
        d.moved = true;
        ind.classList.add("drag");
      }
      const dt = Math.max(1, e.timeStamp - d.lt);
      d.v = d.v * 0.6 + ((e.clientX - d.lx) / dt) * 0.4;
      d.lx = e.clientX;
      d.lt = e.timeStamp;
      ind.style.setProperty("--sx", String(Math.min(0.14, Math.abs(d.v) * 0.08).toFixed(3)));
      ind.style.transform = `translateX(${slotAt(e.clientX).px}px)`;
    },
    onPointerUp: (e: RPointerEvent) => {
      const d = drag.current;
      drag.current = null;
      const ind = indRef.current;
      if (!d || !ind) return;
      ind.classList.remove("lift", "drag");
      ind.style.removeProperty("--sx");
      // A tap. The bar holds the pointer, so the tab's own click may not arrive: switch here (a second
      // switch to the same tab from the click does nothing).
      if (!d.moved) {
        tapTab(TABS[slotAt(e.clientX).i].id);
        return;
      }
      const t = TABS[slotAt(e.clientX).i].id;
      ind.style.transform = `translateX(${TABS.findIndex((x) => x.id === t) * 100}%)`;
      if (t !== tab || pushed) setTab(t);
      else if (pushed) setPushed(null);
    },
    onPointerCancel: () => {
      drag.current = null;
      const ind = indRef.current;
      if (!ind) return;
      ind.classList.remove("lift", "drag");
      ind.style.removeProperty("--sx");
      ind.style.transform = `translateX(${TABS.findIndex((x) => x.id === tab) * 100}%)`;
    },
  };
  const mainRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      const i = TABS.findIndex((x) => x.id === tab);
      const near = [TABS[i - 1]?.id, TABS[i + 1]?.id].filter(Boolean) as Tab[];
      setSeen((x) => (near.every((n) => x.has(n)) ? x : new Set([...x, ...near])));
    }, 600);
    return () => window.clearTimeout(t);
  }, [tab]);
  const ptrRef = useRef<HTMLDivElement | null>(null);
  const ptr = usePullRefresh(mainRef, ptrRef, () => askPc(), !pushed && !wide);
  const pane = (id: string) => mainRef.current?.querySelector<HTMLElement>(`:scope > [data-pane="${id}"]`) ?? null;
  const onSwipe = useCallback(
    (d: 1 | -1) => {
      swiped.current = true;
      if (pushed) return d === -1 ? push(null) : undefined;
      const i = TABS.findIndex((x) => x.id === tab) + d;
      if (i >= 0 && i < TABS.length) setTab(TABS[i].id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, pushed],
  );
  useSwipe(mainRef, onSwipe, (d) => (wide ? false : pushed ? d === -1 : TABS.findIndex((x) => x.id === tab) + d >= 0 && TABS.findIndex((x) => x.id === tab) + d < TABS.length), {
    target: () => pane(pushed ? "pushed" : tab),
    peer: (d) => (pushed ? (d === -1 ? pane(tab) : null) : TABS[TABS.findIndex((x) => x.id === tab) + d] ? pane(TABS[TABS.findIndex((x) => x.id === tab) + d].id) : null),
  });
  // Cards from the PC version link to tabs by module id.
  const cardNav = useMemo(
    () => ({
      tab,
      go: (t: string) => (t === "health" || t === "fitness" ? push(t) : t === "running" ? setTab("training") : t === "checklist" || t === "tasks" || t === "calendar" ? (plannerView(t === "checklist" ? "habits" : t), setTab("planner")) : t === "weather" ? push("weather") : setTab("today")),
    }),
    [tab],
  );

  // Refresh: ask the PC to sync Strava, Garmin and the calendar now, then wait for the copy it sends back.
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const askPc = async () => {
    if (asking) return;
    setAsking(true);
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
    await syncAppleHealth(true).catch(() => {});
    try {
      if (cloudOn()) {
        // Cloud sync on: the service fetches from Garmin and the calendars itself, PC or no PC.
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
      answer = `Your PC didn't answer${made ? ` (it last sent data ${ago(made)})` : ""}. It's probably asleep, off, or Pacelife is closed; open Pacelife on the PC and it catches up within a minute.`;
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
    // The spinning refresh button says it's working; words only when there's news or a problem.
    setNote(/^Up to date/.test(answer) && answer.length < 40 ? null : answer);
    setAsking(false);
    window.setTimeout(() => setNote((x) => (x === answer ? null : x)), 8000);
  };

  const check = async () => {
    setBusy(true);
    try {
      if (await refresh()) await notifyChanged("*");
      // Apple Health is read here on the phone (at most every ten minutes).
      await syncAppleHealth().catch(() => {});
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

  const slide = dir === 1 ? " slide-from-right" : dir === -1 ? " slide-from-left" : "";
  // Each page carries its own title, so it slides with the page (no jump when the title changes size).
  const pageTitle = (title: string, sub?: string | null) => (
    <div className="p-title">
      <h1>{title}</h1>
      {sub && <span>{sub}</span>}
    </div>
  );
  return (
    <PhoneNav.Provider value={phoneNav}>
      <NavContext.Provider value={cardNav}>
        <div className={"p-app" + (wide ? " p-wide" : "")}>
          <header className="p-head">
            {pushed ? (
              <button className="p-back" onClick={() => setPushed(null)}>
                ‹ {TABS.find((t) => t.id === tab)!.label}
              </button>
            ) : (
              <button className="p-gear" onClick={() => push("settings")} aria-label="Settings and account">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                  <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
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
          <PullBeat busy={ptr.busy} innerRef={ptrRef} />
          <main ref={mainRef} className="p-main p-track">
            {pushed && (
              <div key={pushed} data-pane="pushed" className={"p-pane on p-pushed" + slide}>
                {pageTitle(PUSHED[pushed].title)}
                {PUSHED[pushed].module ? <ModulePage id={PUSHED[pushed].module!} /> : PUSHED_PAGE[pushed]!()}
              </div>
            )}
            {TABS.filter((t) => seen.has(t.id)).map((t) => {
              const on = !pushed && t.id === tab;
              return (
                <section key={t.id} data-pane={t.id} className={"p-pane" + (on ? " on" + slide : "")} aria-hidden={!on}>
                  {t.id === "today" && wide ? null : t.id === "today" ? pageTitle(new Date().toLocaleDateString("en-GB", { weekday: "long" }), new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" })) : pageTitle(t.label)}
                  {t.id === "today" ? wide ? <WebToday /> : <Today /> : t.id === "training" ? <Training /> : t.id === "runs" ? <Runs /> : t.id === "planner" ? <Planner /> : <Stats />}
                </section>
              );
            })}
          </main>
          <AutoReview />
          <nav className="p-tabs" role="tablist" style={{ ["--tabs" as string]: TABS.length }} ref={tabsRef} {...(wide ? {} : tabDrag)}>
            <span ref={indRef} className={"p-tab-ind" + (pushed ? " off" : "")} style={{ transform: `translateX(${TABS.findIndex((x) => x.id === tab) * 100}%)` }} aria-hidden="true" />
            {wide && (
              <span className="p-side-brand" aria-hidden="true">
                <img src="icon-192.png" alt="" />
                Pacelife
              </span>
            )}
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={!pushed && tab === t.id} className={`p-tab tab-${t.id}` + (!pushed && tab === t.id ? " on" : "")} onClick={() => tapTab(t.id)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
                <span>{t.label}</span>
              </button>
            ))}
            {wide &&
              WIDE_EXTRA.map((t) => (
                <button key={t.id} className={`p-tab p-tab-extra` + (pushed === t.id ? " on" : "")} onClick={() => push(t.id)}>
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

/** Show or hide the Planner tab (calendar, to-do, habits). */
function PlannerToggle() {
  const [on, setOn] = useState(plannerShown());
  return (
    <label className="p-row p-toggle">
      <span className="p-row-main">
        <span className="p-row-title">Show Planner</span>
        <span className="p-row-sub">Calendar, to-do and habits: a tab of their own, and on Today</span>
      </span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          setPlannerShown(e.target.checked);
        }}
      />
    </label>
  );
}

/** Dark or light, and your accent colour (this phone only). */
function TrainingSettings() {
  const src = useFocusSource();
  return (
    <section className="p-section">
      <div className="p-section-head">
        <h2>Training</h2>
      </div>
      <PlannerToggle />
      <div className="p-group p-look">
        <span className="p-row-title">Load focus values</span>
        <div className="p-seg">
          {(
            [
              ["garmin", "Garmin's"],
              ["own", "Pacelife's"],
            ] as const
          ).map(([m, l]) => (
            <button key={m} className={src === m ? "on" : ""} onClick={() => saveFocusSource(m)}>
              {l}
            </button>
          ))}
        </div>
        <span className="p-row-sub">
          {src === "garmin"
            ? "The same numbers and optimal ranges as your watch (when Garmin is connected). Planned weeks use Garmin's ranges too."
            : "Pacelife's own estimate from each run's pace and heart rate, against typical ranges. It won't match your watch."}
        </span>
      </div>
    </section>
  );
}

function Appearance() {
  const [look, setLook] = useState(phoneLook);
  const put = (l: Partial<PhoneLook>) => {
    const n = { ...look, ...l };
    setLook(n);
    setPhoneLook(n);
  };
  return (
    <section className="p-section">
      <div className="p-section-head">
        <h2>Appearance</h2>
      </div>
      <div className="p-group p-look">
        <div className="p-seg">
          {(
            [
              ["dark", "Dark"],
              ["light", "Light"],
              ["auto", "Match iPhone"],
            ] as const
          ).map(([m, l]) => (
            <button key={m} className={look.mode === m ? "on" : ""} onClick={() => put({ mode: m })}>
              {l}
            </button>
          ))}
        </div>
        <div className="p-swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button key={a.id} role="radio" aria-checked={look.accent === a.id} className={"p-swatch" + (look.accent === a.id ? " on" : "")} style={{ ["--sw" as string]: a.dark }} onClick={() => put({ accent: a.id })}>
              <i />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** The gear at the top: your account, Garmin, a PC, and the plan's settings. */
function SettingsPage() {
  const nav = usePhoneNav();
  return <More push={nav.push} />;
}

function More({ push }: { push: (p: Pushed) => void }) {
  const rows: [Exclude<Pushed, null>, string, string][] = [
    ["adjust", "Your plan and races", "Build a plan, races and tapers, import a CSV"],
    ["workout", "Create a workout", "Pick what to work on, get suggestions, send it to your watch"],
    ["watch", "Workout editor", "Every step by hand, and watch sync settings"],
    ["weather", "Weather", "Forecast for your runs"],
  ];
  return (
    <div className="p-screen">
      <div className="p-brand">
        <img src="apple-touch-icon.png" alt="" width={56} height={56} />
        <span>
          <b>Pacelife</b>
          <small>Train, race, recover</small>
        </span>
      </div>
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
      <TrainingSettings />
      <Appearance />
      <AccountSection />
      {!hasAccount() && <PhoneFooter />}
    </div>
  );
}

function PhoneFooter() {
  const [armed, setArmed] = useState(false);
  return (
    <footer className="p-footer">
      <p>Runs, health, the plan and your calendar come from the PC whenever Pacelife is open there. Tasks, habits and plan changes made here are sent back to it.</p>
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
