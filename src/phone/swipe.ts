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
export interface SwipeTargets {
  /** What moves under your finger (default: the element listened on). */
  target?: () => HTMLElement | null;
  /** The page next door, drawn alongside while you drag so it's never blank. */
  peer?: (dir: 1 | -1) => HTMLElement | null;
}

export function useSwipe(ref: RefObject<HTMLElement | null>, onSwipe: (dir: 1 | -1) => void, canGo: (dir: 1 | -1) => boolean = () => true, targets: SwipeTargets = {}) {
  const cb = useRef({ onSwipe, canGo, targets });
  cb.current = { onSwipe, canGo, targets };
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let s: { x: number; y: number; t: number; axis: "x" | "y" | null; dx: number; can: boolean; el: HTMLElement; peer: HTMLElement | null; pdir: 1 | -1 | 0 } | null = null;
    const ease = (ms: number) => (ms ? `transform ${ms}ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity ${ms}ms` : "none");
    const set = (el: HTMLElement, tx: number, ms: number, fade: boolean) => {
      el.style.transition = ease(ms);
      el.style.transform = tx ? `translate3d(${tx}px, 0, 0)` : "";
      el.style.opacity = fade && tx ? String(Math.max(0.55, 1 - Math.abs(tx) / el.offsetWidth / 1.6)) : "";
    };
    const clearPeer = (p: HTMLElement | null) => {
      if (!p) return;
      p.classList.remove("peeking");
      p.style.transition = p.style.transform = p.style.top = "";
    };
    /** Line the neighbour up with the top of the screen, just off to the side. */
    const showPeer = (p: HTMLElement, dir: 1 | -1, tx: number, ms: number) => {
      if (!p.classList.contains("peeking")) {
        const box = host.getBoundingClientRect();
        const head = document.querySelector(".p-head")?.getBoundingClientRect().bottom ?? 0;
        p.style.top = `${Math.max(0, Math.max(0, head) - box.top)}px`;
        p.classList.add("peeking");
      }
      p.style.transition = ease(ms);
      p.style.transform = `translate3d(${dir * host.offsetWidth + tx}px, 0, 0)`;
    };
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || ownsSideways(e.target as Element, host)) return void (s = null);
      const el = cb.current.targets.target?.() ?? host;
      s = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), axis: null, dx: 0, can: true, el, peer: null, pdir: 0 };
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
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      s.can = cb.current.canGo(dir);
      s.dx = dx;
      if (reduced()) return;
      if (s.pdir !== dir) {
        clearPeer(s.peer);
        s.peer = s.can ? (cb.current.targets.peer?.(dir) ?? null) : null;
        s.pdir = dir;
      }
      set(s.el, s.can ? dx : dx * 0.25, 0, !s.peer);
      if (s.peer) showPeer(s.peer, dir, dx, 0);
    };
    const up = () => {
      if (!s || s.axis !== "x") return void (s = null);
      const { dx, t, can, el, peer } = s;
      s = null;
      const w = host.offsetWidth || 375;
      const v = Math.abs(dx) / Math.max(1, Date.now() - t);
      const dir: 1 | -1 = dx < 0 ? 1 : -1;
      if (can && (Math.abs(dx) > w * 0.25 || (v > 0.5 && Math.abs(dx) > 40))) {
        if (reduced()) return cb.current.onSwipe(dir);
        set(el, -dir * w, 180, !peer);
        if (peer) showPeer(peer, dir, -dir * w, 180);
        window.setTimeout(() => {
          cb.current.onSwipe(dir);
          if (peer) {
            // The neighbour is the page now: drop the drag styles once React has moved it into place.
            requestAnimationFrame(() => {
              clearPeer(peer);
              set(el, 0, 0, false);
            });
          } else if (el.isConnected) {
            // Still here (the weeks): bring the new content in from the other side.
            set(el, dir * w * 0.35, 0, true);
            requestAnimationFrame(() => requestAnimationFrame(() => set(el, 0, 220, true)));
          }
        }, 170);
      } else {
        set(el, 0, 220, !peer);
        if (peer) {
          showPeer(peer, dir, 0, 220);
          window.setTimeout(() => clearPeer(peer), 230);
        }
      }
    };
    host.addEventListener("touchstart", down, { passive: true });
    host.addEventListener("touchmove", move, { passive: false });
    host.addEventListener("touchend", up, { passive: true });
    host.addEventListener("touchcancel", up, { passive: true });
    return () => {
      host.removeEventListener("touchstart", down);
      host.removeEventListener("touchmove", move);
      host.removeEventListener("touchend", up);
      host.removeEventListener("touchcancel", up);
    };
  });
}
