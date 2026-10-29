import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { backend } from "@backend";
import { getSettings, subscribeSettings } from "../core/settings";
import { useNow } from "../core/time";
import { NavContext } from "./nav";
import { moduleById, modules } from "../modules/registry";
import { ErrorBoundary } from "./ErrorBoundary";
import { COLS, ROWS, findSpot, loadLayout, resolveLayout, saveLayout, type ResolvedLayout } from "./layout";
import { SettingsPanel } from "./SettingsPanel";

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

/** Top-level tabs: the overview, then every module that has a page. */
function useTabs() {
  return useMemo(
    () => [
      { id: "overview", label: "Overview" },
      ...modules
        .filter((m) => m.page)
        .sort((a, b) => a.page!.order - b.page!.order)
        .map((m) => ({ id: m.id, label: m.page!.label })),
    ],
    [],
  );
}

function ModulePage({ id }: { id: string }) {
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
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const go = useCallback(
    (next: string) => {
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
  const [gridRef, size] = useSize();
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const idle = useIdle(4000);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    loadLayout().then((saved) => setLayout(resolveLayout(saved, modules)));
  }, []);

  const persist = useCallback((next: ResolvedLayout) => {
    setLayout(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveLayout(next), 300);
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

  if (!layout) return <div className="dashboard" ref={gridRef} />;

  const rowHeight = Math.max(8, (size.h - MARGIN * (ROWS + 1)) / ROWS);
  const visible = modules.filter((m) => layout.items[m.id]);
  const gridLayout: Layout[] = visible.map((m) => ({
    i: m.id,
    ...layout.items[m.id],
    minW: m.minW ?? 2,
    minH: m.minH ?? 2,
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
      findSpot(m.defaultPos, taken) ?? findSpot({ x: 0, y: 0, w: m.minW ?? 2, h: m.minH ?? 2 }, taken);
    if (!spot) {
      setNotice(`No room for ${m.title}. Shrink or hide another card first.`);
      return;
    }
    setNotice(null);
    persist({ items: { ...layout.items, [id]: spot }, hidden: layout.hidden.filter((h) => h !== id), custom: true });
  };
  const reset = () => persist(resolveLayout(null, modules));

  const cursorHidden = idle && settings.hideCursor && !editing && !settingsOpen;

  return (
    <NavContext.Provider value={nav}>
    <div className={"app" + (cursorHidden ? " cursor-hidden" : "") + (editing ? " is-editing" : "")}>
      <header className="topbar">
        <nav className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={"tab" + (tab === t.id ? " on" : "")} onClick={() => go(t.id)}>
              {tab === t.id && <span className="tab-ind" aria-hidden="true" />}
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
        <HeaderClock />
        <div className="topbar-actions">
          {tab === "overview" && !editing && (
            <button className="btn ghost" onClick={() => setEditing(true)} title="Rearrange the overview (Ctrl+E)">
              Edit
            </button>
          )}
          <button className="btn ghost icon" onClick={() => setSettingsOpen(true)} title="Settings (Ctrl+,)" aria-label="Settings">
            ⚙
          </button>
        </div>
      </header>

      {editing && (
        <div className="edit-bar">
          <span>{notice ?? "Drag cards by their top bar, resize from the corner."}</span>
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
      ) : (
      <div className="dashboard" ref={gridRef}>
        {size.w > 0 && (
          <GridLayout
            layout={gridLayout}
            cols={COLS}
            maxRows={ROWS}
            width={size.w}
            rowHeight={rowHeight}
            margin={[MARGIN, MARGIN]}
            containerPadding={[MARGIN, MARGIN]}
            isDraggable={editing}
            isResizable={editing}
            draggableHandle=".drag-handle"
            compactType="vertical"
            onLayoutChange={onLayoutChange}
            resizeHandles={["se"]}
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
    </div>
    </NavContext.Provider>
  );
}
