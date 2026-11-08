/** How far the page is scrolled, whichever element does the scrolling. */
export function pageScrollTop(): number {
  return Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop);
}
/** Back to the top at once (no animation), whichever element does the scrolling. */
export function resetPageScroll() {
  window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}
