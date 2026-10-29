import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import GridLayout, { type Layout } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import { backend } from "@backend";
import { getSettings, subscribeSettings } from "../core/settings";
import { moduleById, modules } from "../modules/registry";
import { ErrorBoundary } from "./ErrorBoundary";
import { COLS, ROWS, findSpot, loadLayout, resolveLayout, saveLayout, type ResolvedLayout } from "./layout";
import { SettingsPanel } from "./SettingsPanel";

const MARGIN = 8;

function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
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

export function Dashboard() {
  const [layout, setLayout] = useState<ResolvedLayout | null>(null);
  const [editing, setEditing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const size = useSize(gridRef);
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

  // Keyboard: Ctrl+E edit layout, Ctrl+, settings, F11 full-screen, Esc closes.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
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
  }, []);

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
    <div className={"app" + (cursorHidden ? " cursor-hidden" : "") + (editing ? " is-editing" : "")}>
      {/* Floating toolbar; while editing, the edit bar takes over so nothing covers the cards. */}
      {!editing && (
        <div className={"toolbar" + (idle ? " toolbar-hidden" : "")}>
          <button className="btn" onClick={() => setEditing(true)} title="Ctrl+E">
            Edit layout
          </button>
          <button className="btn" onClick={() => setSettingsOpen(true)} title="Ctrl+,">
            Settings
          </button>
        </div>
      )}

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
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          <button className="btn btn-primary" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      )}

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
                    <m.Card editing={editing} />
                  </ErrorBoundary>
                </div>
              </div>
            ))}
          </GridLayout>
        )}
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
