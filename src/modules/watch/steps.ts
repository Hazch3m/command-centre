/**
 * Workouts in garmin-coach's own format: steps with kind, duration, target and
 * notes, and repeats that wrap steps. Durations: "10:00", "90s", "800m", "5km",
 * "lap". Targets: "open", "pace 4:50-5:05/km", "hr zone 2". Pace is min/km.
 */

export type StepKind = "warmup" | "interval" | "recovery" | "rest" | "cooldown" | "other";
export const STEP_KINDS: StepKind[] = ["warmup", "interval", "recovery", "rest", "cooldown", "other"];
export const KIND_LABEL: Record<StepKind | "repeat", string> = {
  warmup: "Warm-up",
  interval: "Run",
  recovery: "Recovery",
  rest: "Rest",
  cooldown: "Cool-down",
  other: "Other",
  repeat: "Repeat",
};

export interface Step {
  id: string;
  kind: StepKind;
  duration: string;
  target: string;
  notes?: string;
}
export interface Repeat {
  id: string;
  kind: "repeat";
  times: number;
  steps: Step[];
}
export type Item = Step | Repeat;

export interface Workout {
  name: string;
  /** Cues for the whole session; goes into the workout's description. */
  description: string;
  sport: string;
  steps: Item[];
}

let seq = 0;
export const newId = () => `s${Date.now().toString(36)}${(seq++).toString(36)}`;

export const step = (kind: StepKind, duration: string, target = "open", notes?: string): Step => ({ id: newId(), kind, duration, target, ...(notes ? { notes } : {}) });
export const repeat = (times: number, steps: Step[]): Repeat => ({ id: newId(), kind: "repeat", times, steps });

/** The JSON garmin-coach expects (no ids, no empty notes). */
export function toToolSteps(items: Item[]): unknown[] {
  return items.map((it) =>
    it.kind === "repeat"
      ? { kind: "repeat", times: it.times, steps: toToolSteps(it.steps) }
      : { kind: it.kind, duration: it.duration.trim(), target: it.target.trim() || "open", ...(it.notes?.trim() ? { notes: it.notes.trim() } : {}) },
  );
}

/** Back from garmin-coach's JSON (templates, saved drafts) to editable items. */
export function fromToolSteps(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    if (o.kind === "repeat") return repeat(Number(o.times) || 1, fromToolSteps(o.steps) as Step[]);
    return step((o.kind as StepKind) ?? "other", String(o.duration ?? "lap"), String(o.target ?? "open"), o.notes ? String(o.notes) : undefined);
  });
}

// ---- targets ----

export type TargetMode = "open" | "pace" | "hrzone" | "custom";
const PACE = /^pace\s+(\d{1,2}:\d{2})\s*(?:-\s*(\d{1,2}:\d{2}))?\s*(?:\/\s*km)?$/i;
const HRZONE = /^hr\s+zone\s+([1-5])$/i;

export function targetMode(t: string): TargetMode {
  const s = t.trim();
  if (!s || /^open$/i.test(s)) return "open";
  if (PACE.test(s)) return "pace";
  if (HRZONE.test(s)) return "hrzone";
  return "custom";
}
export function paceParts(t: string): [string, string] {
  const m = PACE.exec(t.trim());
  return m ? [m[1], m[2] ?? ""] : ["", ""];
}
export const paceTarget = (a: string, b: string) => `pace ${a.trim()}${b.trim() ? `-${b.trim()}` : ""}/km`;
export const hrZone = (t: string) => Number(HRZONE.exec(t.trim())?.[1] ?? 2);

// ---- reading ----

const secs = (t: string) => {
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] ?? 0);
};

/** Rough length of a step in seconds (for the builder's total), null when unknown. */
export function stepSeconds(s: Step, easyPace = 320): number | null {
  const d = s.duration.trim().toLowerCase();
  if (/^\d+:\d{2}(:\d{2})?$/.test(d)) return secs(d);
  let m = /^(\d+(?:\.\d+)?)\s*(s|sec)$/.exec(d);
  if (m) return +m[1];
  m = /^(\d+(?:\.\d+)?)\s*min$/.exec(d);
  if (m) return +m[1] * 60;
  m = /^(\d+(?:\.\d+)?)\s*(m|km)$/.exec(d);
  if (m) {
    const km = m[2] === "km" ? +m[1] : +m[1] / 1000;
    const [a, b] = paceParts(s.target);
    const pace = a ? (secs(a) + secs(b || a)) / 2 : easyPace;
    return km * pace;
  }
  return null;
}

export function totalSeconds(items: Item[]): number {
  return items.reduce((t, it) => t + (it.kind === "repeat" ? it.times * totalSeconds(it.steps) : stepSeconds(it) ?? 0), 0);
}

export const fmtDuration = (s: number) => {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`;
};

/** Where a step sits, for messages: "Step 3" or "Step 2 › 1" (inside a repeat). */
export function stepPath(items: Item[], id: string): string | null {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.id === id) return `Step ${i + 1}`;
    if (it.kind === "repeat") {
      const j = it.steps.findIndex((s) => s.id === id);
      if (j >= 0) return `Step ${i + 1} › ${j + 1}`;
    }
  }
  return null;
}
