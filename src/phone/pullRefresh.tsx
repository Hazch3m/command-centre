import { useEffect, useRef, useState, type RefObject } from "react";
import { pageScrollTop } from "./scroll";

const PULL = 76;

/**
 * Pull down from the top of a page to refresh. The page follows your finger smoothly
 * (drawn every frame, no re-render per pixel); let go past the line and `onRefresh` runs while
 * the Pacelife heartbeat line beats.
 */
export function usePullRefresh(ref: RefObject<HTMLElement | null>, indicator: RefObject<HTMLElement | null>, onRefresh: () => Promise<unknown> | void, enabled = true) {
  const [busy, setBusy] = useState(false);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let s: { y: number; x: number; axis: "x" | "y" | null; d: number } | null = null;
    let raf = 0;
    let target = 0;
    let shown = 0;
    let spinning = false;
    const paint = () => {
      // Ease towards where the finger is, so it never stutters.
      shown += (target - shown) * 0.35;
      if (Math.abs(target - shown) < 0.3) shown = target;
      const ind = indicator.current;
      const f = Math.min(1, shown / PULL);
      el.style.transform = shown ? `translate3d(0, ${shown}px, 0)` : "";
      if (ind) {
        ind.style.height = `${shown}px`;
        ind.style.opacity = String(spinning ? 1 : f);
        ind.style.setProperty("--f", String(f));
        ind.classList.toggle("ready", f >= 1);
      }
      raf = shown !== target ? requestAnimationFrame(paint) : 0;
    };
    const go = (t: number) => {
      target = t;
      if (!raf) raf = requestAnimationFrame(paint);
    };
    const down = (e: TouchEvent) => {
      s = !spinning && pageScrollTop() <= 0 && e.touches.length === 1 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, axis: null, d: 0 } : null;
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const dy = e.touches[0].clientY - s.y;
      const dx = e.touches[0].clientX - s.x;
      if (!s.axis) {
        if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return;
        s.axis = dy > 0 && Math.abs(dy) > Math.abs(dx) * 1.2 ? "y" : "x";
        if (s.axis === "x") return void (s = null);
      }
      if (pageScrollTop() > 0 || dy <= 0) return go((s.d = 0));
      e.preventDefault();
      // Rubber band: easy at first, firmer the further you pull.
      s.d = PULL * 1.7 * (1 - Math.exp(-dy / (PULL * 2.2)));
      go(s.d);
    };
    const up = async () => {
      const d = s?.d ?? 0;
      s = null;
      if (d >= PULL) {
        spinning = true;
        setBusy(true);
        go(PULL * 0.85);
        try {
          await Promise.all([cb.current(), new Promise((r) => setTimeout(r, 900))]);
        } finally {
          spinning = false;
          setBusy(false);
          go(0);
        }
      } else go(0);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", up, { passive: true });
    el.addEventListener("touchcancel", up, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.style.transform = "";
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", up);
      el.removeEventListener("touchcancel", up);
    };
  }, [ref, indicator, enabled]);
  return { busy };
}

/** The Pacelife heartbeat line: draws itself as you pull, then beats while refreshing. */
export function PullBeat({ busy, innerRef }: { busy: boolean; innerRef: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={innerRef} className={"p-ptr" + (busy ? " busy" : "")} aria-hidden={!busy} role={busy ? "status" : undefined} aria-label={busy ? "Refreshing" : undefined}>
      <svg viewBox="0 0 120 40" className="p-beat">
        <path pathLength={100} d="M4 22H34L41 12L50 34L59 6L66 22H104" />
        <circle cx="111" cy="22" r="4.5" />
      </svg>
      <small>{busy ? "Refreshing" : ""}</small>
    </div>
  );
}
