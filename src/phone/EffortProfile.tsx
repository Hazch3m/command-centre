import { useMemo } from "react";
import type { Plan } from "../modules/running/plan";
import { sessionToWorkout, type Zones } from "../modules/watch/importWeek";
import type { Item, Step } from "../modules/watch/steps";
import { sessionKindOf } from "../modules/running/planBuilder";

/** The zone a session's hard parts belong to, by what it says it trains. */
export type Zone = "easy" | "long" | "threshold" | "vo2" | "race" | "rest";
export function zoneOf(text: string, kind?: string): Zone {
  if (!text || /^rest/i.test(text) || kind === "rest") return "rest";
  const k = sessionKindOf(text);
  if (k === "VO2 max" || k === "Hill strength") return "vo2";
  if (k === "Threshold") return "threshold";
  if (/VO2|fartlek|hill reps|hill strength/i.test(text)) return "vo2";
  if (/\b(?:MP|HMP)\b|race pace|time trial/i.test(text)) return "race";
  if (/threshold|\bT\b|tempo|cruise/i.test(text)) return "threshold";
  if (/× [\d.]+ km at|× \d+ min at/i.test(text)) return "threshold";
  if (/long run/i.test(text) || kind === "long") return "long";
  return "easy";
}

const paceOf = (target: string) => {
  const m = /(\d{1,2}):(\d{2})\s*(?:-\s*(\d{1,2}):(\d{2}))?/.exec(target);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2];
  const b = m[3] ? +m[3] * 60 + +m[4] : a;
  return (a + b) / 2;
};
/** Rough seconds for a step, so blocks are as wide as they take. */
function secondsOf(s: Step): number {
  const d = s.duration.trim().toLowerCase();
  const p = paceOf(s.target) ?? (s.kind === "interval" ? 230 : 330);
  let m = /^(\d+(?:\.\d+)?)\s*km$/.exec(d);
  if (m) return +m[1] * p;
  m = /^(\d+)\s*m$/.exec(d);
  if (m) return (+m[1] / 1000) * p;
  m = /^(\d+):(\d{2})$/.exec(d);
  if (m) return +m[1] * 60 + +m[2];
  m = /^(\d+)\s*s$/.exec(d);
  if (m) return +m[1];
  m = /^(\d+(?:\.\d+)?)\s*min$/.exec(d);
  if (m) return +m[1] * 60;
  return 600; // "lap": the rest of the run
}

interface Block {
  w: number;
  h: number;
  zone: Zone;
}

export const zonesOf = (plan?: Plan): Zones => {
  const z = (re: RegExp) => plan?.paces.find((x) => re.test(x.zone))?.now;
  return { MP: z(/^Marathon pace/i), HMP: z(/^Half marathon pace/i), T: z(/^Threshold/i) };
};

/** A session as blocks: width how long each part takes, height how hard, colour its zone. */
export function profileOf(text: string, kind: string | undefined, plan?: Plan): Block[] {
  const zone = zoneOf(text, kind);
  if (zone === "rest") return [];
  const w = sessionToWorkout(text, zonesOf(plan));
  const flat: Step[] = [];
  const add = (it: Item) => (it.kind === "repeat" ? Array.from({ length: it.times }, () => it.steps.forEach((s) => flat.push(s))) : flat.push(it));
  w?.steps.forEach(add);
  if (flat.length <= 1) return [{ w: 1, h: zone === "long" ? 0.42 : 0.32, zone: zone === "long" ? "long" : "easy" }];
  // A strides-only easy run is still an easy run.
  if (zone === "easy" || zone === "long") {
    const hard = flat.filter((s) => s.kind === "interval" && paceOf(s.target));
    if (!hard.length) return [{ w: 1, h: zone === "long" ? 0.42 : 0.32, zone }];
  }
  return flat.map((s) => {
    const p = paceOf(s.target);
    const hard = s.kind === "interval";
    // 6:30/km easy … 3:00/km very fast.
    const h = hard ? (p ? Math.max(0.5, Math.min(1, 0.5 + (390 - p) / 380)) : 0.75) : s.kind === "recovery" || s.kind === "rest" ? 0.16 : 0.3;
    return { w: secondsOf(s), h, zone: hard ? (zone === "long" ? "race" : zone) : "easy" };
  });
}

/** The shape of a session, like Runna's: warm-up, reps and jogs, cool-down. */
export function EffortProfile({ text, kind, plan, height = 56 }: { text: string; kind?: string; plan?: Plan; height?: number }) {
  const blocks = useMemo(() => profileOf(text, kind, plan), [text, kind, plan]);
  if (!blocks.length) return null;
  const total = blocks.reduce((a, b) => a + b.w, 0);
  const gap = blocks.length > 1 ? 2 : 0;
  const W = 300;
  const inner = W - gap * (blocks.length - 1);
  let x = 0;
  return (
    <svg className="effort" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img" aria-label="The session's shape: how hard each part is and how long it takes">
      {blocks.map((b, i) => {
        const bw = Math.max(1.5, (b.w / total) * inner);
        const bh = Math.max(4, b.h * height);
        const r = <rect key={i} className={`effort-b z-${b.zone}`} x={x} y={height - bh} width={bw} height={bh} rx={Math.min(3, bw / 2)} />;
        x += bw + gap;
        return r;
      })}
    </svg>
  );
}

// ---- The session's parts, with how long each one is ------------------------------

export interface Segment {
  kind: "warmup" | "work" | "cooldown" | "easy";
  label: string;
  detail: string;
  km: number;
}

const kmOfStep = (s: Step): number | null => {
  const d = s.duration.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*km$/.exec(d);
  if (m) return +m[1];
  m = /^(\d+)\s*m$/.exec(d);
  if (m) return +m[1] / 1000;
  if (d === "lap") return null;
  const p = paceOf(s.target) ?? (s.kind === "interval" ? 230 : 330);
  return secondsOf(s) / p;
};
const durText = (s: Step): string => {
  const d = s.duration.trim().toLowerCase();
  let m = /^(\d+):(\d{2})$/.exec(d);
  if (m) return +m[2] ? `${+m[1]}:${m[2]} min` : `${+m[1]} min`;
  m = /^(\d+)\s*s$/.exec(d);
  if (m) return +m[1] >= 60 && +m[1] % 60 === 0 ? `${+m[1] / 60} min` : `${m[1]} s`;
  m = /^(\d+)\s*m$/.exec(d);
  if (m) return `${m[1]} m`;
  m = /^(\d+(?:\.\d+)?)\s*km$/.exec(d);
  if (m) return `${m[1]} km`;
  return d;
};
const targetText = (s: Step): string => {
  const p = /(\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?)/.exec(s.target)?.[1];
  if (p) return `at ${p.replace(/\s*-\s*/, "–")}/km`;
  if (/zone 1|zone 2/i.test(s.target) || s.kind === "warmup" || s.kind === "cooldown") return "easy";
  return s.kind === "recovery" ? "jog" : s.kind === "rest" ? "rest" : "";
};

/** Warm-up, the work (reps grouped) and cool-down, each with its length, adding up to the session's distance. */
export function segmentsOf(text: string, plan?: Plan): Segment[] {
  const w = sessionToWorkout(text, zonesOf(plan));
  if (!w || w.steps.length < 2) return [];
  const total = Number(/^(?:easy\s+)?(\d+(?:\.\d+)?)\s*km\b/i.exec(text.trim())?.[1] ?? /(\d+(?:\.\d+)?)\s*km\b/i.exec(text)?.[1] ?? NaN);
  const out: (Segment & { open?: boolean })[] = [];
  for (const it of w.steps) {
    if (it.kind === "repeat") {
      const work = it.steps.find((s) => s.kind === "interval") ?? it.steps[0];
      const rest = it.steps.find((s) => s !== work);
      const km = it.steps.reduce((a, s) => a + (kmOfStep(s) ?? 0), 0) * it.times;
      const restText = !rest ? "" : /^float/i.test(rest.notes ?? "") ? `${durText(rest)} float ${targetText(rest)} (steady, not a jog)` : rest.kind === "recovery" && rest.target === "open" ? `${durText(rest)} easy jog` : `${durText(rest)} ${targetText(rest) || "jog"}`;
      out.push({ kind: "work", label: `${it.times} × ${durText(work)}`, detail: [targetText(work), restText.trim()].filter(Boolean).join(", "), km });
    } else {
      const km = kmOfStep(it);
      // An "interval" with only an easy heart-rate target is the easy part of a run, not work.
      const easyStep = it.kind === "interval" && !paceOf(it.target) && /zone [12]\b/i.test(it.target);
      const kind = it.kind === "warmup" ? "warmup" : it.kind === "cooldown" ? "cooldown" : it.kind === "interval" && !easyStep ? "work" : "easy";
      const label = it.kind === "warmup" ? "Warm-up" : it.kind === "cooldown" ? "Cool-down" : kind === "work" ? durText(it) : it.kind === "recovery" ? `${durText(it)} easy jog` : `${durText(it)} easy`;
      out.push({ kind, label, detail: kind === "work" ? targetText(it) : km == null ? "the rest of the run" : kind === "easy" ? "" : targetText(it), km: km ?? 0, open: km == null });
    }
  }
  // "Until the lap button": whatever's left of the session's distance.
  const known = out.filter((s) => !s.open).reduce((a, s) => a + s.km, 0);
  const open = out.filter((s) => s.open);
  if (open.length) for (const s of open) s.km = isFinite(total) ? Math.max(0, (total - known) / open.length) : 0;
  return out;
}

const kmText = (km: number) => (km >= 9.95 ? Math.round(km) : Math.round(km * 10) / 10).toString();

/** The parts of a session as a list: "Warm-up 3 km · 6 × 1 km at 3:40/km, 90 s jog 7.2 km · Cool-down 1.8 km". */
export function SessionSegments({ text, plan }: { text: string; plan?: Plan }) {
  const segs = useMemo(() => segmentsOf(text, plan), [text, plan]);
  if (!segs.length) return null;
  const sum = segs.reduce((a, s) => a + s.km, 0);
  return (
    <ol className="segs" aria-label="The session's parts">
      {segs.map((s, i) => (
        <li key={i} className={`seg seg-${s.kind}`}>
          <i aria-hidden="true" />
          <span className="seg-what">
            <b>{s.label}</b>
            {s.detail && <small>{s.detail}</small>}
          </span>
          <span className="seg-km num">{s.km ? `${s.km < 1 && s.km * 1000 < 995 ? "≈" : ""}${kmText(s.km)} km` : "–"}</span>
        </li>
      ))}
      <li className="seg seg-total">
        <span className="seg-what">Total</span>
        <span className="seg-km num">≈{kmText(sum)} km</span>
      </li>
    </ol>
  );
}

// ---- A done workout: its laps matched to the session's steps --------------------------------

export interface LapLike {
  distance: number;
  moving_time: number;
  speed: number;
  hr?: number | null;
}
export interface WorkoutLap {
  lap: LapLike;
  role: "warmup" | "work" | "recovery" | "cooldown" | "other";
  label: string;
  /** Target pace range, s/km. */
  target: [number, number] | null;
}

const rangeOf = (target: string): [number, number] | null => {
  const m = /(\d{1,2}):(\d{2})\s*(?:-\s*(\d{1,2}):(\d{2}))?/.exec(target);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2];
  return [a, m[3] ? +m[3] * 60 + +m[4] : a];
};

/**
 * Names each lap of a structured run: when the laps line up with the planned steps (the watch makes a
 * lap per step) they take the step's name and target; otherwise the clearly faster laps are the reps.
 */
export function workoutLaps(laps: LapLike[], planned: string | null | undefined, plan?: Plan): WorkoutLap[] | null {
  const ls = laps.filter((l) => l.distance > 30 && l.moving_time > 5);
  if (ls.length < 4) return null;
  const w = planned ? sessionToWorkout(planned, zonesOf(plan)) : null;
  const flat: { s: Step; rep?: number; of?: number }[] = [];
  for (const it of w?.steps ?? []) {
    if (it.kind === "repeat") for (let r = 0; r < it.times; r++) for (const st of it.steps) flat.push({ s: st, rep: r + 1, of: it.times });
    else flat.push({ s: it });
  }
  const roleOf = (k: string): WorkoutLap["role"] => (k === "warmup" ? "warmup" : k === "cooldown" ? "cooldown" : k === "interval" ? "work" : k === "recovery" || k === "rest" ? "recovery" : "other");
  // Walk the steps, each taking the laps it covers: a 3 km warm-up the watch split into three 1 km laps
  // is one warm-up; a timed rep is one lap. Laps of one step are added together.
  if (flat.length >= 3) {
    const out: WorkoutLap[] = [];
    let j = 0;
    let ok = true;
    for (let k = 0; k < flat.length && j < ls.length; k++) {
      const f = flat[k];
      const d = f.s.duration.trim().toLowerCase();
      const km = /^(\d+(?:\.\d+)?)\s*km$/.exec(d);
      const mm = /^(\d+)\s*m$/.exec(d);
      const tm = /^(\d+):(\d{2})$/.exec(d);
      const ss = /^(\d+)\s*s$/.exec(d);
      const wantM = km ? +km[1] * 1000 : mm ? +mm[1] : null;
      const wantS = tm ? +tm[1] * 60 + +tm[2] : ss ? +ss[1] : null;
      const last = k === flat.length - 1 || d === "lap";
      let dist = 0;
      let time = 0;
      let hrT = 0;
      const start = j;
      do {
        const l = ls[j++];
        dist += l.distance;
        time += l.moving_time;
        hrT += (l.hr ?? 0) * l.moving_time;
      } while (j < ls.length && (last ? d === "lap" && k === flat.length - 1 : wantM != null ? dist < wantM * 0.9 : wantS != null ? time < wantS * 0.85 : false));
      // A step that swallowed far more than it asked for means the laps don't follow the steps.
      if ((wantS != null && time > wantS * 1.6 + 20) || (wantM != null && dist > wantM * 1.5 + 100)) ok = false;
      const lap: LapLike = { distance: dist, moving_time: time, speed: time ? dist / time : 0, hr: hrT && time ? hrT / time : null };
      const role = roleOf(f.s.kind);
      const float = /^float/i.test(f.s.notes ?? "");
      const name = role === "warmup" ? "Warm-up" : role === "cooldown" ? "Cool-down" : role === "work" ? `Rep ${f.rep ?? ""}${f.of ? ` of ${f.of}` : ""}`.trim() : float ? "Float" : "Recovery";
      out.push({ lap, role, label: name + (j - start > 1 && role !== "work" ? ` (${j - start} laps)` : ""), target: role === "work" || float ? rangeOf(f.s.target) : null });
    }
    // Whatever's left (strides, a split cool-down) as it is.
    for (; j < ls.length; j++) out.push({ lap: ls[j], role: "cooldown", label: "Cool-down", target: null });
    const reps = out.filter((x) => x.role === "work");
    const rest = out.filter((x) => x.role === "recovery");
    const pc = (x: WorkoutLap) => x.lap.moving_time / Math.max(1, x.lap.distance / 1000);
    const avg = (xs: WorkoutLap[]) => xs.reduce((a, x) => a + pc(x), 0) / Math.max(1, xs.length);
    if (ok && reps.length >= 2 && (!rest.length || avg(reps) < avg(rest))) return out;
  }
  // No match: by pace. Reps are the laps well faster than the run's middle pace.
  const paces = ls.map((l) => l.moving_time / (l.distance / 1000)).sort((a, b) => a - b);
  const mid = paces[Math.floor(paces.length / 2)];
  const fast = ls.filter((l) => l.moving_time / (l.distance / 1000) < mid * 0.93).length;
  if (fast < 2) return null;
  let rep = 0;
  return ls.map((lap, i) => {
    const p = lap.moving_time / (lap.distance / 1000);
    const work = p < mid * 0.93;
    if (work) rep++;
    const role: WorkoutLap["role"] = work ? "work" : rep === 0 ? "warmup" : rep >= fast && !ls.slice(i + 1).some((x) => x.moving_time / (x.distance / 1000) < mid * 0.93) ? "cooldown" : "recovery";
    return { lap, role, label: work ? `Rep ${rep}` : role === "warmup" ? "Warm-up" : role === "cooldown" ? "Cool-down" : "Recovery", target: null };
  });
}
