import { useMemo } from "react";
import type { Plan } from "../modules/running/plan";
import { sessionToWorkout, type Zones } from "../modules/watch/importWeek";
import type { Item, Step } from "../modules/watch/steps";

/** The zone a session's hard parts belong to, by what it says it trains. */
export type Zone = "easy" | "long" | "threshold" | "vo2" | "race" | "rest";
export function zoneOf(text: string, kind?: string): Zone {
  if (!text || /^rest/i.test(text) || kind === "rest") return "rest";
  if (/VO2|× \d+(?:\.\d+)? ?(?:m|s)\b|fartlek|hill/i.test(text)) return "vo2";
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

const zonesOf = (plan?: Plan): Zones => {
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
