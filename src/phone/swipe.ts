import { useEffect, type RefObject } from "react";

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

/**
 * Swipe left or right across the page to move between tabs (or right to go back from a page you opened).
 * Mostly-horizontal, quick swipes only, so scrolling down a page never changes tab.
 */
export function useSwipe(ref: RefObject<HTMLElement | null>, onSwipe: (dir: 1 | -1) => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number } | null = null;
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || ownsSideways(e.target as Element, el)) return void (start = null);
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const up = (e: TouchEvent) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = Date.now() - start.t < 650;
      start = null;
      if (quick && Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.8) onSwipe(dx < 0 ? 1 : -1);
    };
    el.addEventListener("touchstart", down, { passive: true });
    el.addEventListener("touchend", up, { passive: true });
    return () => {
      el.removeEventListener("touchstart", down);
      el.removeEventListener("touchend", up);
    };
  }, [ref, onSwipe]);
}
