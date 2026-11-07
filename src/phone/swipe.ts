import { useEffect, useRef, type RefObject } from "react";

/** Inside something that scrolls sideways itself (a chart, a strip of chips, a slider, a map), a swipe belongs to it. */
function ownsSideways(el: Element | null, stop: Element): boolean {
  for (let e = el; e && e !== stop; e = e.parentElement) {
    if (e instanceof HTMLInputElement && e.type === "range") return true;
    if ((e as HTMLElement).dataset?.noswipe != null || e.classList.contains("leaflet-container") || e.tagName === "CANVAS") return true;
    const st = getComputedStyle(e);
    if ((st.overflowX === "auto" || st.overflowX === "scroll") && e.scrollWidth > e.clientWidth + 2) return true;
  }
  return false;
}

const reduced = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Swipe sideways and the page follows your finger: let go past about a quarter
 * of the screen (or flick) and it moves on, otherwise it springs back. Up-and-down
 * scrolling is left alone: the direction is decided in the first few pixels.
 *
 * `canGo(dir)` says whether there's somewhere to go (at the ends the page only
 * gives a little). When the element stays on screen (weeks), the new content
 * slides in from the side it came from.
 */
export function useSwipe(ref: RefObject<HTMLElement | null>, onSwipe: (dir: 1 | -1) => void, canGo: (dir: 1 | -1) => boolean = () => true) {
  const cb = useRef({ onSwipe, canGo });
  cb.current = { onSwipe, canGo };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s: { x: number; y: number; t: number; axis: "x" | "y" | null; dx: number; can: boolean } | null = null;
    const set = (tx: number, ms: number) => {
      el.style.transition = ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${ms}ms` : "none";
      el.style.transform = tx ? `translate3d(${tx}px, 0, 0)` : "";
      el.style.opacity = tx ? String(Math.max(0.55, 1 - Math.abs(tx) / el.offsetWidth / 1.6)) : "";
    };
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || ownsSideways(e.target as Element, el)) return void (s = null);
      s = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), axis: null, dx: 0, can: true };
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const dx = e.touches[0].clientX - s.x;
      const dy = e.touches[0].clientY - s.y;
      if (!s.axis) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        s.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
        if (s.axis === "y") return;
      }
      if (s.axis !== "x") return;
      e.preventDefault();
      s.can = cb.current.canGo(dx < 0 ? 1 : -1);
      s.dx = dx;
      if (!reduced()) set(s.can ? dx : dx * 0.25, 0);
    };
    const up = () => {
      if (!s || s.axis !== "x") return void (s = null);
      const { dx, t, can } = s;
      s = null;
      const w = el.offsetWidth || 375;
      const v = Math.abs(dx) / Math.max(1, Date.now() - t);
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      if (can && (Math.abs(dx) > w * 0.25 || (v > 0.5 && Math.abs(dx) > 40))) {
        if (reduced()) return cb.current.onSwipe(dir);
        set(-dir * w, 160);
        window.setTimeout(() => {
          cb.current.onSwipe(dir);
          // Still here (the weeks): bring the new content in from the other side.
          if (el.isConnected) {
            set(dir * w * 0.35, 0);
            requestAnimationFrame(() => requestAnimationFrame(() => set(0, 220)));
          }
        }, 150);
      } else set(0, 220);
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
  });
}
