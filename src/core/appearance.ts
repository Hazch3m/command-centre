/**
 * Accent colours you can pick (Settings → Appearance), each tuned for dark and
 * light. The zone colours (easy, threshold, VO2, race pace) stay fixed: they mean
 * something; the accent is yours.
 */
export interface Accent {
  id: string;
  name: string;
  dark: string;
  light: string;
}
export const ACCENTS: Accent[] = [
  { id: "teal", name: "Track", dark: "#3fd1aa", light: "#0e8467" },
  { id: "ocean", name: "Ocean", dark: "#5aa9ff", light: "#1d62c4" },
  { id: "sunset", name: "Sunset", dark: "#ff8c42", light: "#c25a12" },
  { id: "violet", name: "Violet", dark: "#b08cff", light: "#6a43d4" },
  { id: "rose", name: "Rose", dark: "#ff6f91", light: "#c22d57" },
  { id: "gold", name: "Gold", dark: "#f5c542", light: "#9a7400" },
];

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Dark text on a bright accent, white on a deep one. */
const onColour = (h: string) => {
  const [r, g, b] = hex(h);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0d1a14" : "#ffffff";
};

/** Sets the accent on the page for the theme in use. */
export function applyAccent(id: string | null | undefined, theme: string) {
  const a = ACCENTS.find((x) => x.id === id);
  const st = document.documentElement.style;
  if (!a) {
    for (const k of ["--accent", "--accent-dim", "--on-accent"]) st.removeProperty(k);
    return;
  }
  const c = theme === "light" ? a.light : a.dark;
  const [r, g, b] = hex(c);
  st.setProperty("--accent", c);
  st.setProperty("--accent-dim", `rgba(${r}, ${g}, ${b}, ${theme === "light" ? 0.12 : 0.16})`);
  st.setProperty("--on-accent", onColour(c));
}

// ---- The phone's own appearance (kept on the phone) ----------------------------------

export interface PhoneLook {
  mode: "dark" | "light" | "auto";
  accent: string;
}
const KEY = "cc-appearance";
export function phoneLook(): PhoneLook {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as PhoneLook | null;
    if (v?.mode && v.accent) return v;
  } catch {
    /* default */
  }
  return { mode: "light", accent: "sunset" };
}
const dark = () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
export function applyPhoneLook(l: PhoneLook = phoneLook()) {
  const theme = l.mode === "auto" ? (dark() ? "dark" : "light") : l.mode;
  document.documentElement.dataset.theme = theme;
  applyAccent(l.accent, theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#eef1f6" : "#121821");
}
export function setPhoneLook(l: PhoneLook) {
  try {
    localStorage.setItem(KEY, JSON.stringify(l));
  } catch {
    /* this time only */
  }
  applyPhoneLook(l);
}
globalThis.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => phoneLook().mode === "auto" && applyPhoneLook());
