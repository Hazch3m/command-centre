import logoUrl from "../../phone-public/apple-touch-icon.png";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { backend } from "@backend";
import { notifyChanged } from "../core/events";
import { getSettings, subscribeSettings } from "../core/settings";
import { useNow } from "../core/time";
import { NavContext } from "./nav";
import { moduleById, modules } from "../modules/registry";
import { ErrorBoundary } from "./ErrorBoundary";
import { COLS, ROWS, defaultFor, fillGaps, findSpot, fitToScreen, loadLayout, orientationOf, resolveLayout, saveLayout, type Orientation, type ResolvedLayout } from "./layout";
import { SettingsPanel } from "./SettingsPanel";
import { RunViewHost } from "../modules/running/RunView";
import { Analysis } from "../modules/running/Analysis";
import { Home } from "./Home";
import { usePlanCalendarSync } from "../modules/running/planCalendar";
import { usePhoneSync } from "../core/phoneSync";
import { useAutoRefresh, useRefresh } from "./refresh";
import { useWatchAutoSync } from "../modules/watch/AutoSyncSetting";

function BackgroundJobs() {
  usePlanCalendarSync();
  usePhoneSync();
  useAutoRefresh();
  useWatchAutoSync();
  return null;
}

/** On the web the data lives in your cloud account: fetch what's new every couple of minutes and when you come back to the tab. */
function WebRefresh() {
  useEffect(() => {
    const pull = () =>
      import("../core/backend.phone").then(async (m) => {
        if (await m.refresh()) await notifyChanged("*");
      });
    const iv = window.setInterval(pull, 2 * 60_000);
    const vis = () => document.visibilityState === "visible" && pull();
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);
  return null;
}

const MARGIN = 10;

/** Size of an element that may mount and unmount (the grid only exists on the overview). */
function useSize() {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.current.observe(el);
  }, []);
  useEffect(() => () => ro.current?.disconnect(), []);
  return [ref, size] as const;
}

/** Hides the pointer after a few idle seconds; reveals the toolbar while the mouse moves. */
function useIdle(ms: number) {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = setTimeout(() => setIdle(true), ms);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("mousedown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("mousedown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [ms]);
  return idle;
}

const TAB_KEY = "cc-tab";
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

function HeaderClock() {
  const now = useNow("minute");
  return (
    <div className="head-clock">
      <span className="num head-time">{hhmm(now)}</span>
      <span className="muted">{dayFmt.format(now)}</span>
    </div>
  );
}

/** Calendar, tasks and habits share one top tab (Planner), as sub-tabs. */
const PLANNER = ["calendar", "tasks", "checklist"];

/** Top-level tabs: the overview, the running pages, Analysis, then Planner. */
function useTabs() {
  return useMemo(() => {
    const pages = modules.filter((m) => m.page && !m.page.inTraining && !PLANNER.includes(m.id)).map((m) => ({ id: m.id, label: m.page!.label, order: m.page!.order }));
    pages.push({ id: "analysis", label: "Analysis", order: 1.2 }, { id: "planner", label: "Planner", order: 3 });
    return [{ id: "overview", label: "Home" }, ...pages.sort((a, b) => a.order - b.order).map(({ id, label }) => ({ id, label }))];
  }, []);
}

const PLANNER_KEY = "cc-planner-tab";
function PlannerPage() {
  const subs = PLANNER.map((id) => moduleById.get(id)).filter((m): m is NonNullable<typeof m> => !!m);
  const [sub, setSub] = useState(() => {
    try {
      const v = localStorage.getItem(PLANNER_KEY);
      if (v && PLANNER.includes(v)) return v;
    } catch {
      /* private mode */
    }
    return "calendar";
  });
  useEffect(() => {
    const on = (e: Event) => setSub((e as CustomEvent<string>).detail);
    window.addEventListener("cc:planner-sub", on);
    return () => window.removeEventListener("cc:planner-sub", on);
  }, []);
  const pick = (id: string) => {
    setSub(id);
    try {
      localStorage.setItem(PLANNER_KEY, id);
    } catch {
      /* private mode */
    }
  };
  return (
    <div className="tab-page tab-page-planner">
      <nav className="segmented page-tabs planner-tabs" role="tablist" aria-label="Planner">
        {subs.map((m) => (
          <button key={m.id} type="button" role="tab" aria-selected={sub === m.id} className={sub === m.id ? "on" : ""} onClick={() => pick(m.id)}>
            {m.page!.label}
          </button>
        ))}
      </nav>
      <ModulePage id={sub} />
    </div>
  );
}

export function ModulePage({ id }: { id: string }) {
  if (id === "planner") return <PlannerPage />;
  if (id === "analysis")
    return (
      <div className="tab-page tab-page-analysis">
        <ErrorBoundary name="Analysis">
          <Analysis />
        </ErrorBoundary>
      </div>
    );
  const m = moduleById.get(id);
  if (!m) return null;
  const Page = m.page?.Page;
  return (
    <div className={`tab-page tab-page-${m.id}`}>
      <ErrorBoundary name={m.title}>
        {Page ? (
          <Page />
        ) : (
          <div className={`card card-page card-${m.id}`}>
            <div className="card-body">
              <m.Card editing={false} variant="page" />
            </div>
          </div>
        )}
      </ErrorBoundary>
    </div>
  );
}

export function Dashboard() {
  const tabs = useTabs();
  const [tab, setTab] = useState(() => {
    try {
      const t = sessionStorage.getItem(TAB_KEY);
      return t && tabs.some((x) => x.id === t) ? t : "overview";
    } catch {
      return "overview";
    }
  });
  const [fallbackAnim, setFallbackAnim] = useState<string | null>(null);
  // Home is the running page; the old board of draggable tiles is still there (e.g. for a second screen).
  const [board, setBoardState] = useState(() => {
    try {
      return localStorage.getItem("cc-board") === "1";
    } catch {
      return false;
    }
  });
  const setBoard = (on: boolean) => {
    setBoardState(on);
    try {
      localStorage.setItem("cc-board", on ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const go = useCallback(
    (next: string) => {
      if (PLANNER.includes(next)) {
        // Calendar, to-do and habits live under Planner now: open that sub-tab.
        try {
          localStorage.setItem(PLANNER_KEY, next);
        } catch {
          /* private mode */
        }
        window.dispatchEvent(new CustomEvent("cc:planner-sub", { detail: next }));
        next = "planner";
      }
      const cur = tabRef.current;
      if (next === cur || !tabs.some((t) => t.id === next)) return;
      const dir = tabs.findIndex((t) => t.id === next) > tabs.findIndex((t) => t.id === cur) ? "fwd" : "back";
      document.documentElement.dataset.navDir = dir;
      try {
        sessionStorage.setItem(TAB_KEY, next);
      } catch {
        /* preview without storage */
      }
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      if (reducedMotion()) setTab(next);
      else if (doc.startViewTransition) doc.startViewTransition(() => flushSync(() => setTab(next)));
      else {
        setFallbackAnim(dir);
        setTab(next);
      }
    },
    [tabs],
  );
  const nav = useMemo(() => ({ tab, go }), [tab, go]);

  const [layout, setLayout] = useState<ResolvedLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useRefresh((m) => {
    setNotice(m);
    window.setTimeout(() => setNotice((x) => (x === m ? null : x)), 8000);
  });
  const [gridRef, size] = useSize();
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const idle = useIdle(4000);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Portrait and landscape screens keep separate layouts.
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const f = () => setWin({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);
  const orient: Orientation = orientationOf(win.w, win.h);
  const orientRef = useRef(orient);
  orientRef.current = orient;
  const ROWS_NOW = ROWS[orient];

  useEffect(() => {
    let live = true;
    setLayout(null);
    loadLayout(orient).then((saved) => live && setLayout(resolveLayout(saved, modules, orient)));
    return () => {
      live = false;
    };
  }, [orient]);

  const persist = useCallback((next: ResolvedLayout) => {
    setLayout(next);
    clearTimeout(saveTimer.current);
    const o = orientRef.current;
    saveTimer.current = setTimeout(() => saveLayout(next, o), 300);
  }, []);

  // Keyboard: Ctrl+1…9 tabs, Ctrl+E edit layout, Ctrl+, settings, F11 full-screen, Esc closes.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const t = tabs[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          go(t.id);
        }
      } else if (e.ctrlKey && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === tabRef.current);
        go(tabs[(i + (e.key === "PageDown" ? 1 : tabs.length - 1)) % tabs.length].id);
      } else if (e.ctrlKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        go("overview");
        setEditing((v) => !v);
      } else if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      } else if (e.key === "F11") {
        e.preventDefault();
        const cfg = await backend.getConfig();
        backend.setFullscreen(!cfg.fullscreen);
      } else if (e.key === "Escape") {
        setSettingsOpen(false);
        setEditing(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, go]);

  // Leaving edit mode: anything left below the bottom of the screen comes back or goes to the tray.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing && layout) {
      const fixed = fitToScreen(layout.items, ROWS_NOW);
      if (fixed.moved.length || fixed.hidden.length) {
        persist({ items: fixed.items, hidden: [...layout.hidden, ...fixed.hidden], custom: true });
        const name = (id: string) => moduleById.get(id)?.title ?? id;
        setNotice(
          [fixed.moved.length ? `Moved back on screen: ${fixed.moved.map(name).join(", ")}.` : "", fixed.hidden.length ? `No room for ${fixed.hidden.map(name).join(", ")}, so it's in the hidden list (Edit to add it back).` : ""]
            .filter(Boolean)
            .join(" "),
        );
      }
    }
    wasEditing.current = editing;
  }, [editing]);

  if (!layout) return <div className="dashboard" ref={gridRef} />;

  const rowHeight = Math.max(8, (size.h - MARGIN * (ROWS_NOW + 1)) / ROWS_NOW);
  const visible = modules.filter((m) => layout.items[m.id]);
  // Outside edit mode, cards grow into any empty space next to them, so there are no holes.
  const shown = editing ? layout.items : fillGaps(layout.items, ROWS_NOW);
  const gridLayout: Layout[] = visible.map((m) => ({
    i: m.id,
    ...shown[m.id],
    minW: 3,
    minH: 2,
  }));

  const onLayoutChange = (l: Layout[]) => {
    if (!editing) return;
    const items = { ...layout.items };
    for (const it of l) items[it.i] = { x: it.x, y: it.y, w: it.w, h: it.h };
    const changed = l.some((it) => {
      const p = layout.items[it.i];
      return !p || p.x !== it.x || p.y !== it.y || p.w !== it.w || p.h !== it.h;
    });
    if (changed) persist({ ...layout, items, custom: true });
  };

  const hide = (id: string) => {
    const { [id]: _removed, ...items } = layout.items;
    persist({ items, hidden: [...layout.hidden, id], custom: true });
  };
  const show = (id: string) => {
    const m = moduleById.get(id)!;
    const taken = Object.values(layout.items);
    const spot =
      findSpot(defaultFor(m, orient), taken, ROWS_NOW) ??
      findSpot({ x: 0, y: 0, w: Math.max(6, (m.minW ?? 3) * 2), h: Math.max(4, m.minH ?? 3) }, taken, ROWS_NOW) ??
      findSpot({ x: 0, y: 0, w: 4, h: 3 }, taken, ROWS_NOW);
    if (!spot) {
      // Screen full: put it just below the line so it can be resized and dragged up once there's room.
      const d = defaultFor(m, orient);
      const below = { x: 0, y: ROWS_NOW, w: Math.min(d.w, COLS), h: d.h };
      setNotice(`${m.title} is below the dashed line. Shrink or hide a card to make room, then drag it up.`);
      persist({ items: { ...layout.items, [id]: below }, hidden: layout.hidden.filter((h) => h !== id), custom: true });
      window.setTimeout(() => document.querySelector(`.card-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
      return;
    }
    setNotice(null);
    persist({ items: { ...layout.items, [id]: spot }, hidden: layout.hidden.filter((h) => h !== id), custom: true });
  };
  const reset = () => persist(resolveLayout(null, modules, orient));


  const cursorHidden = idle && settings.hideCursor && !editing && !settingsOpen;

  return (
    <NavContext.Provider value={nav}>
    <div className={"app" + (cursorHidden ? " cursor-hidden" : "") + (editing ? " is-editing" : "")}>
      <header className="topbar">
        <span className="brand" aria-label="Pacelife">
          <img src={logoUrl} alt="" width={30} height={30} />
          <b>Pacelife</b>
        </span>
        <nav className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab tab-${t.id}` + (tab === t.id ? " on" : "")} onClick={() => go(t.id)}>
              {tab === t.id && <span className="tab-ind" aria-hidden="true" />}
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
        <HeaderClock />
        <div className="topbar-actions">
          {tab === "overview" && !editing && (
            <button className="btn ghost" onClick={() => setBoard(!board)} title={board ? "Back to the running home page" : "The board of tiles you can arrange (good on a second screen)"}>
              {board ? "Home view" : "Board view"}
            </button>
          )}
          {tab === "overview" && board && !editing && (
            <button className="btn ghost" onClick={() => setEditing(true)} title="Rearrange the board (Ctrl+E)">
              Edit
            </button>
          )}
          <button className={"btn ghost icon refresh-btn" + (refresh.busy ? " busy" : "")} onClick={refresh.go} disabled={refresh.busy} title="Refresh: Strava, Garmin, calendar and weather now (F5)" aria-label="Refresh">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="btn ghost icon" onClick={() => setSettingsOpen(true)} title="Settings (Ctrl+,)" aria-label="Settings">
            ⚙
          </button>
        </div>
      </header>

      {!editing && notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button className="btn icon ghost" onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
      {editing && (
        <div className="edit-bar">
          <span>{notice ?? `Editing the ${orient} layout: drag tiles by their top bar, resize from any edge or corner. Anything pushed below the dashed line comes back on screen when you click Done.`}</span>
          {layout.hidden.length > 0 && (
            <span className="edit-hidden">
              Hidden:
              {layout.hidden.map((id) => (
                <button key={id} className="btn" onClick={() => show(id)}>
                  + {moduleById.get(id)?.title ?? id}
                </button>
              ))}
            </span>
          )}
          <button className="btn" onClick={reset}>
            Reset layout
          </button>
          <button className="btn btn-primary" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}

      <main className={"stage" + (fallbackAnim ? ` enter-${fallbackAnim}` : "")} key={tab} onAnimationEnd={() => setFallbackAnim(null)}>
      {tab !== "overview" ? (
        <ModulePage id={tab} />
      ) : !board && !editing ? (
        <div className="tab-page tab-page-home">
          <ErrorBoundary name="Home">
            <Home />
          </ErrorBoundary>
        </div>
      ) : (
      <div
        className="dashboard"
        ref={gridRef}
        style={{ ["--col-w" as string]: `${(size.w - MARGIN) / COLS}px`, ["--row-h" as string]: `${rowHeight + MARGIN}px`, ["--gap" as string]: `${MARGIN}px` }}
      >
        {editing && <div className="screen-edge" style={{ top: `${MARGIN + ROWS_NOW * (rowHeight + MARGIN) - MARGIN / 2}px` }} aria-hidden="true"><span>Bottom of the screen</span></div>}
        {size.w > 0 && (
          <GridLayout
            layout={gridLayout}
            cols={COLS}
            maxRows={editing ? ROWS_NOW * 2 : ROWS_NOW}
            width={size.w}
            rowHeight={rowHeight}
            margin={[MARGIN, MARGIN]}
            containerPadding={[MARGIN, MARGIN]}
            isDraggable={editing}
            isResizable={editing}
            draggableHandle=".drag-handle"
            compactType={null}
            preventCollision={false}
            onLayoutChange={onLayoutChange}
            resizeHandles={["se", "e", "s", "sw", "w"]}
            useCSSTransforms={false}
          >
            {visible.map((m) => (
              <div key={m.id} className={`card card-${m.id}`}>
                {editing && (
                  <div className="drag-handle">
                    <span>⠿ {m.title}</span>
                    <button className="btn icon" onMouseDown={(e) => e.stopPropagation()} onClick={() => hide(m.id)} aria-label={`Hide ${m.title}`} title="Hide card">
                      ✕
                    </button>
                  </div>
                )}
                <div className="card-body">
                  <ErrorBoundary name={m.title}>
                    <m.Card editing={editing} variant="tile" />
                  </ErrorBoundary>
                </div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>
      )}
      </main>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
      <RunViewHost />
      {backend.kind === "phone" ? <WebRefresh /> : <BackgroundJobs />}
    </div>
    </NavContext.Provider>
  );
}
