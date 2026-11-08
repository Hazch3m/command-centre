import { useEffect, useRef, useState, type RefObject } from "react";

const PULL = 72;

/**
 * Pull down from the top of a page to refresh: a spinner follows your finger,
 * let go past the line and `onRefresh` runs (the spinner keeps turning until it's done).
 */
export function usePullRefresh(ref: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown> | void, enabled = true) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let s: { y: number; x: number; axis: "x" | "y" | null; d: number } | null = null;
    const down = (e: TouchEvent) => {
      s = window.scrollY <= 0 && e.touches.length === 1 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, axis: null, d: 0 } : null;
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const dy = e.touches[0].clientY - s.y;
      const dx = e.touches[0].clientX - s.x;
      if (!s.axis) {
        if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
        s.axis = dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 ? "y" : "x";
        if (s.axis === "x") return void (s = null);
      }
      if (window.scrollY > 0 || dy <= 0) return void setPull(0);
      e.preventDefault();
      // Resistance: the further you pull, the slower it follows.
      s.d = Math.min(PULL * 1.6, dy * 0.5);
      setPull(s.d);
    };
    const up = async () => {
      const d = s?.d ?? 0;
      s = null;
      if (d >= PULL) {
        setBusy(true);
        setPull(PULL * 0.8);
        try {
          await cb.current();
        } finally {
          setBusy(false);
          setPull(0);
        }
      } else setPull(0);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", up, { passive: true });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [ref, enabled]);
  return { pull, busy };
}

export function PullSpinner({ pull, busy }: { pull: number; busy: boolean }) {
  if (!pull && !busy) return null;
  const f = Math.min(1, pull / PULL);
  return (
    <div className="p-ptr" style={{ height: pull, opacity: busy ? 1 : f }} aria-hidden={!busy} role={busy ? "status" : undefined} aria-label={busy ? "Refreshing" : undefined}>
      <svg viewBox="0 0 24 24" className={busy ? "spin" : ""} style={busy ? undefined : { transform: `rotate(${f * 300}deg)` }}>
        <circle cx="12" cy="12" r="9" strokeDasharray={`${f * 50} 60`} />
      </svg>
      {!busy && <small>{f >= 1 ? "Let go to refresh" : "Pull to refresh"}</small>}
    </div>
  );
}
