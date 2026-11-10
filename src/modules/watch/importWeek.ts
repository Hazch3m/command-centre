import { addDays, dateKey, parseKey } from "../../core/time";
import { repeat, step, type Item, type Workout } from "./steps";

/**
 * Turns a week of sessions pasted from the Monday review email into draft
 * workouts. One line per day, starting with the day ("Tue: 4 × 6 min T at
 * 3:46–3:50, 1 min jog", "Wednesday 11 Nov – 12 km easy + strength A").
 * Rest days are skipped. Anything it can't read becomes a plain "run to feel"
 * workout with the text as its notes, flagged for a look.
 */

export interface Draft extends Workout {
  key: string;
  date: string;
  source: string;
  /** Something the reader wasn't sure about; shown on the draft. */
  warning?: string;
}

/** Training paces from the plan ("now" column), used for "at MP", "T" etc. */
export interface Zones {
  MP?: string;
  HMP?: string;
  T?: string;
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_RE = /^\W*(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*(?:(\d{1,2})(?:st|nd|rd|th)?\s*([a-z]{3})[a-z]*|(\d{1,2})[/.](\d{1,2}))?\s*[:\-–—|·,]?\s*(.*)$/i;

/** Monday of the week the pasted sessions are for: this week on a Monday, otherwise next week. */
export function defaultWeekStart(today: string): string {
  const dow = (parseKey(today).getDay() + 6) % 7; // 0 = Monday
  return dow === 0 ? today : addDays(today, 7 - dow);
}

const norm = (s: string) =>
  s
    .replace(/[–—]/g, "-")
    .replace(/(\d)\s*[x×]\s*(\d)/gi, "$1 × $2")
    .replace(/(\d),(\d{3})\b/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

const paceIn = (s: string): [string, string] | null => {
  const m = /(\d{1,2}:\d{2})(?:\s*[-–—]\s*(\d{1,2}:\d{2}))?/.exec(s);
  return m ? [m[1], m[2] ?? ""] : null;
};
const pace = (p: [string, string]) => `pace ${p[0]}${p[1] ? `-${p[1]}` : ""}/km`;
const paceText = (p: [string, string]) => `${p[0]}${p[1] ? `–${p[1]}` : ""}`;

/** "6 min" → "6:00", "90 s" → "90s", "1.6 km" → "1.6km", "800 m" → "800m". */
function dur(n: string, unit: string): string {
  const v = parseFloat(n);
  const u = unit.toLowerCase();
  if (u.startsWith("min")) return `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`;
  if (u === "s" || u.startsWith("sec")) return `${Math.round(v)}s`;
  if (u === "km") return `${v}km`;
  return `${Math.round(v)}m`;
}
const durLabel = (n: string, unit: string) => `${n} ${unit.toLowerCase().startsWith("min") ? "min" : unit.toLowerCase().startsWith("s") ? "s" : unit.toLowerCase()}`;

/** The pace a session asks for: a number in the text, else a named zone (MP, HMP, T). */
function targetPace(s: string, zones: Zones): [string, string] | null {
  const p = paceIn(s);
  if (p) return p;
  if (/\bHMP\b/.test(s) && zones.HMP) return paceIn(zones.HMP);
  if (/\bMP\b/.test(s) && zones.MP) return paceIn(zones.MP);
  if (/\bT\b|threshold|tempo/i.test(s) && zones.T) return paceIn(zones.T);
  return null;
}

function strides(s: string): Item[] {
  const m = /(\d+)\s*×\s*(\d+)\s*s\s*strides/i.exec(s) ?? (/strides/i.test(s) ? ["", "6", "20"] : null);
  if (!m) return [];
  return [repeat(+m[1], [step("interval", `${m[2]}s`, "open", "Stride: quick and relaxed"), step("recovery", "60s", "open", "Walk or jog back")])];
}

/** One session's text → steps, name and cues; null for rest days. */
export function sessionToWorkout(text: string, zones: Zones = {}): Omit<Draft, "key" | "date" | "source"> | null {
  // A double: the watch gets the main run; the second (" · PM: 6 km easy") is its own easy run.
  const raw = norm(text.replace(/\s*·\s*PM:.*$/i, ""));
  if (!raw || /^(rest|none|off|day off)\b/i.test(raw)) return null;
  const strength = /strength\s+([AB])\b/i.exec(raw);
  const s = raw.replace(/\s*\+\s*strength\s+[AB]\b/i, "").trim();
  const extra = strength ? ` Strength ${strength[1].toUpperCase()} after.` : "";
  const total = /^(?:easy\s+)?(\d+(?:\.\d+)?)\s*km\b/i.exec(s);

  // Over-unders: "Threshold over-unders: 3 × (4 × 2 min at 3:58-4:02 + 1 min at 3:38-3:42), 2 min jog".
  const ou = /over-unders?:\s*(\d+)\s*×\s*\(\s*(\d+)\s*×\s*(\d+(?:\.\d+)?)\s*(min|s)\s*at\s*(\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?)\s*\+\s*(\d+(?:\.\d+)?)\s*(min|s)\s*at\s*(\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?)\s*\)(?:\s*,\s*(\d+(?:\.\d+)?)\s*(min|s)\s*jog)?/i.exec(s);
  if (ou) {
    const under = paceIn(ou[5])!;
    const over = paceIn(ou[8])!;
    const pair = repeat(+ou[2], [step("interval", dur(ou[3], ou[4]), pace(under), `Under: ${paceText(under)}/km, controlled`), step("interval", dur(ou[6], ou[7]), pace(over), `Over: ${paceText(over)}/km, a surge`)]);
    const rest = step("recovery", ou[9] ? dur(ou[9], ou[10]) : "2:00", "open", "Easy jog");
    const middle: Item[] = Array.from({ length: +ou[1] }, (_, i) => (i ? [rest, { ...pair, id: `${pair.id}-${i}` }] : [pair])).flat();
    const wu = /(\d+(?:\.\d+)?)\s*km warm-up/i.exec(s)?.[1];
    return {
      name: `Over-unders ${ou[1]}×(${ou[2]}×${durLabel(ou[3], ou[4])}/${durLabel(ou[6], ou[7])})`,
      sport: "running",
      steps: [step("warmup", wu ? `${wu}km` : "3km", "hr zone 2", "Easy"), ...middle, total ? step("cooldown", "lap", "hr zone 2", `Easy to finish the ${total[1]} km, then lap`) : step("cooldown", "10:00", "hr zone 2", "Easy")],
      description: `${raw}. The "under" just below threshold, the "over" a controlled surge just above; don't slow right down after the surge.${extra}`,
    };
  }

  // Repeats: "4 × 6 min T at 3:46-3:50, 1 min jog", "8 × 10 s hill sprints", "10 × 1 min on, 1 min off";
  // several sets in turn: "4 × 1 min at 3:40, 1 min jog; then 4 × 2 min at 3:55, 1 min jog".
  const reps = [...s.matchAll(/(\d+)\s*×\s*(\d+(?:\.\d+)?)\s*(km|m|min|s)\b(?!\s*strides)/gi)];
  if (reps.length) {
    const hills = /hill/i.test(s);
    const sets = reps.map((rep, i) => {
      const end = i + 1 < reps.length ? reps[i + 1].index! : s.length;
      const after = s.slice(rep.index! + rep[0].length, end);
      const p = targetPace(after.split(",")[0] + " " + (reps.length > 1 ? "" : s), zones) ?? (reps.length > 1 ? targetPace(s, zones) : null);
      const rec = /(?:,|\+)\s*(\d+(?::\d{2})?(?:\.\d+)?)\s*(min|s|m)?\s*(?:jog|walk|rest|easy|off|recovery)/i.exec(after) ?? /(\d+(?::\d{2})?)\s*(min|s)?\s*(?:jog|off)/i.exec(after);
      // A float: the recovery at a pace ("1 min float at 4:28-4:34"), not a jog.
      const fl = /(\d+(?:\.\d+)?)\s*(min|s)\s*float(?:\s*at\s*(\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?))?/i.exec(after);
      const recDur = fl ? dur(fl[1], fl[2]) : rec ? (rec[1].includes(":") ? rec[1] : dur(rec[1], rec[2] ?? "min")) : hills ? "90s" : "2:00";
      const fp = fl?.[3] ? paceIn(fl[3]) : null;
      const work = step("interval", dur(rep[2], rep[3]), p ? pace(p) : "open", hills ? "Hill sprint: fast, tall, relaxed" : p ? `${paceText(p)}/km` : "Hard but controlled");
      const back = fl ? step("recovery", recDur, fp ? pace(fp) : "open", fp ? `Float: ${paceText(fp)}/km, keep moving` : "Float: steady, keep moving") : step("recovery", recDur, "open", hills ? "Walk back down" : "Easy jog");
      return { block: repeat(+rep[1], [work, back]), p, label: `${rep[1]}×${durLabel(rep[2], rep[3])}`, after };
    });
    // Between sets: two easy minutes before the next one starts.
    const middle: Item[] = sets.flatMap((x, i) => (i ? [step("recovery", "2:00", "open", "Easy between sets"), x.block] : [x.block]));
    const p = sets[0].p;
    // Written in ("3 km warm-up … 2 km cool-down"), or 3 km and the rest to finish the run.
    const wu = /(\d+(?:\.\d+)?)\s*km warm-up/i.exec(s)?.[1];
    const warm = wu ? step("warmup", `${wu}km`, "hr zone 2", "Easy") : total ? step("warmup", "3km", "hr zone 2", "Easy") : step("warmup", "15:00", "hr zone 2", "Easy, build to steady");
    const cool = total ? step("cooldown", "lap", "hr zone 2", `Easy to finish the ${total[1]} km, then lap`) : step("cooldown", "10:00", "hr zone 2", "Easy");
    const kind = hills ? (/hill reps|hill strength/i.test(s) ? "Hill reps" : "Hill sprints") : /fartlek/i.test(s) ? "Fartlek" : /vo2/i.test(s) ? "VO2 max" : /\bT\b|threshold/i.test(s) ? "Threshold" : /\bHMP\b/.test(s) ? "HMP" : /\bMP\b/.test(s) ? "MP" : "Intervals";
    const name = sets.length > 1 ? `${kind} ${sets.map((x) => x.label).join(" + ")}` : `${kind} ${sets[0].label}${p ? ` @ ${paceText(p)}` : ""}`;
    return {
      name,
      sport: "running",
      steps: [warm, ...middle, cool, ...strides(sets[sets.length - 1].after.replace(reps[reps.length - 1][0], ""))],
      description: `${raw}. ${hills ? "Full recovery between sprints." : sets.length > 1 ? "Each set at its own pace; easy between sets." : p ? `Hit ${paceText(p)}/km from the first rep; even splits, the last should feel like the first.` : "Controlled effort."}${extra}`,
    };
  }

  // A run in steps: "15 km progression run: 5 km easy, 4 km at 4:40-4:46, 4 km at 4:25-4:31, 2 km at 4:10-4:16".
  const stepped = /^(\d+(?:\.\d+)?)\s*km\s+(progression|long)(?:\s+run)?\s*:\s*(\d+(?:\.\d+)?)\s*km easy\s*,(.+)$/i.exec(s);
  if (stepped) {
    const blocks = [...stepped[4].matchAll(/(\d+(?:\.\d+)?)\s*km at\s*((?:HMP|MP|T)\b|\d{1,2}:\d{2}(?:\s*[-–]\s*\d{1,2}:\d{2})?)/gi)];
    if (blocks.length) {
      const steps: Item[] = [step("interval", `${stepped[3]}km`, "hr zone 2", "Easy start")];
      for (const b of blocks) {
        const p = targetPace(b[2], zones);
        steps.push(step("interval", `${b[1]}km`, p ? pace(p) : "open", p ? `${paceText(p)}/km` : `${b[2]} effort`));
      }
      return {
        name: `${/progression/i.test(stepped[2]) ? "Progression" : "Long"} ${stepped[1]} km: ${blocks.map((b) => b[1]).join("/")} km faster`,
        sport: "running",
        steps,
        description: `${raw}. Each block a little quicker than the last; the easy start really easy.${extra}`,
      };
    }
  }

  // Long run with a faster finish or block: "28 km, last 6 at 4:05", "35 km, 22 at 3:58-4:02", "26 km, 14 at MP".
  const lng = /^(\d+(?:\.\d+)?)\s*km(?:\s+(?:long|progression|medium-long)(?:\s+run)?)?\s*,?\s*(last\s+)?(\d+(?:\.\d+)?)\s*(?:km\s*)?at\b/i.exec(s);
  if (lng) {
    const tot = +lng[1];
    const fast = +lng[3];
    const p = targetPace(s.slice(lng.index + lng[0].length) + " " + s, zones);
    const t = p ? pace(p) : "open";
    const steps: Item[] = lng[2]
      ? [step("interval", `${tot - fast}km`, "hr zone 2", "Easy"), step("interval", `${fast}km`, t, p ? `${paceText(p)}/km: smooth, not a race` : "Marathon effort")]
      : [step("warmup", "4km", "hr zone 2", "Easy"), step("interval", `${fast}km`, t, p ? `${paceText(p)}/km` : "Marathon effort"), step("cooldown", `${Math.max(1, tot - fast - 4)}km`, "hr zone 2", "Easy")];
    return {
      name: `${/progression/i.test(s) ? "Progression" : "Long"} ${tot} km, ${lng[2] ? "last " : ""}${fast} km${p ? ` @ ${paceText(p)}` : " MP"}`,
      sport: "running",
      steps,
      description: `${raw}. Fuel every 30–40 min; keep the easy part truly easy.${extra}`,
    };
  }

  // A continuous block at pace: "25 min T at 3:43-3:46", "10 km with 6 km at 3:58", "16 km with 10 km at MP".
  const block = /(\d+(?:\.\d+)?)\s*(km|min)\s*(?:T\s*)?(?:at|@)\s*(?:(?:HMP|MP|T)\b\s*)?(\d{1,2}:\d{2})?/i.exec(total ? s.slice(total[0].length) : s);
  if (block && (block[3] || /\bat\s*(HMP|MP|T)\b/i.test(s))) {
    const p = targetPace(s.slice(s.indexOf(block[0])), zones);
    const kind = /\bHMP\b/.test(s) ? "HMP" : /\bMP\b/.test(s) ? "MP" : /\bT\b|threshold|tempo/i.test(s) ? "Tempo" : "Steady";
    return {
      name: `${kind} ${block[1]} ${block[2]}${p ? ` @ ${paceText(p)}` : ""}`,
      sport: "running",
      steps: [
        step("warmup", /(\d+(?:\.\d+)?)\s*km warm-up/i.exec(s) ? `${/(\d+(?:\.\d+)?)\s*km warm-up/i.exec(s)![1]}km` : total ? "3km" : "15:00", "hr zone 2", "Easy"),
        step("interval", dur(block[1], block[2]), p ? pace(p) : "open", p ? `${paceText(p)}/km` : undefined),
        total ? step("cooldown", "lap", "hr zone 2", `Easy to finish the ${total[1]} km`) : step("cooldown", "10:00", "hr zone 2", "Easy"),
      ],
      description: `${raw}. Settle into the pace in the first km, then hold it.${extra}`,
    };
  }

  // Easy, recovery, long and medium-long runs: "12 km easy", "Easy 45 min + 4 strides", "7 km recovery".
  const km = /(\d+(?:\.\d+)?)\s*km/i.exec(s);
  const min = /(\d+)\s*min/i.exec(s);
  const recovery = /recovery|very easy/i.test(s);
  // Recovery runs are easy runs kept short and gentle: zone 2 like the rest (zone 1 is barely running for most people).
  const zone = "hr zone 2";
  const kind = recovery ? "Recovery" : /long/i.test(s) || (km && +km[1] >= 18) ? "Long" : /medium/i.test(s) ? "Medium-long" : "Easy";
  const st = strides(s);
  if (km || min) {
    return {
      name: `${kind} ${km ? `${km[1]} km` : `${min![1]} min`}${st.length ? " + strides" : ""}`,
      sport: "running",
      steps: [step("interval", km ? `${km[1]}km` : `${min![1]}:00`, zone, recovery ? "Very easy" : "Easy, conversational"), ...st],
      description: `${raw}. ${recovery ? "Keep it very easy." : "Easy: you could hold a conversation."}${extra}`,
    };
  }
  if (/easy|recovery|jog/i.test(s)) {
    return {
      name: `${kind} run${st.length ? " + strides" : ""}`,
      sport: "running",
      steps: [step("interval", "lap", zone, "Easy; press lap to finish"), ...st],
      description: `${raw}.${extra}`,
      warning: "No distance or time given: runs until you press lap.",
    };
  }
  return {
    name: s.slice(0, 40),
    sport: "running",
    steps: [step("other", "lap", "open", s.slice(0, 120))],
    description: `${raw}.${extra}`,
    warning: "Couldn't read this one; it's a single step with the text as notes. Check it in the builder.",
  };
}

/** Every dated session in the pasted text. */
export function parseWeek(text: string, weekStart: string, zones: Zones = {}): Draft[] {
  const out: Draft[] = [];
  const year = parseKey(weekStart).getFullYear();
  for (const line of text.split(/\r?\n/)) {
    const m = DAY_RE.exec(line.trim());
    if (!m || !m[6]?.trim()) continue;
    const dow = DAYS.indexOf(m[1].toLowerCase().slice(0, 3));
    let date = addDays(weekStart, dow);
    if (m[2] && MONTHS.includes(m[3].toLowerCase().slice(0, 3))) date = dateKey(new Date(year, MONTHS.indexOf(m[3].toLowerCase().slice(0, 3)), +m[2]));
    else if (m[4]) date = dateKey(new Date(year, +m[5] - 1, +m[4]));
    // Several sessions in one line ("Easy 10 km. Thu: 2 × 5 km") stay one draft per day: take this day's part.
    const body = m[6].split(/\.\s+(?=(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b)/i)[0].trim();
    const w = sessionToWorkout(body, zones);
    if (w) out.push({ ...w, key: `${date}-${out.length}`, date, source: body });
  }
  return out;
}
