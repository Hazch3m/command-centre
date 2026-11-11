import { addDays } from "../../core/time";
import { forecastWeek } from "./forecast";
import { mondayOf, WEEK_KEYS, type Plan } from "./plan";
import { buildPlan, type History } from "./planBuilder";
import { predictTime } from "./vo2";

/**
 * Freshen a plan without rebuilding it: weeks, long runs, mileage, races, your changes and history all
 * stay. Paces can be moved to your fitness now, and the speed workouts from next week can be swapped
 * for the builder's current ones (same days, same number per week).
 */
const PACE = /(\d{1,2}):(\d{2})/g;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Every pace in a text times r (3:52 at r 0.97 → 3:45). Durations like "45:00" (over 10 min) stay. */
export function scalePaces(text: string, r: number): string {
  return text.replace(PACE, (m, a, b, at: number) => {
    const s = +a * 60 + +b;
    // Not a pace: a duration ("2:30 jog", "45:00").
    if (s < 150 || s > 600 || /^\s*(?:jog|easy|rest|walk|min|float|recovery)/i.test(text.slice(at + m.length))) return m;
    return fmt(Math.round(s * r));
  });
}

export interface RefreshResult {
  plan: Plan;
  paced: number;
  swapped: number;
  examples: { date: string; from: string; to: string }[];
}

export function refreshPlan(raw: Plan, o: { paces: boolean; workouts: boolean }, vNow: number | null, h: History | null, today: string): RefreshResult {
  const from = addDays(mondayOf(today), 7);
  const vOld = raw.built?.vdot ?? null;
  const r = o.paces && vNow && vOld ? predictTime(42195, vNow) / predictTime(42195, vOld) : 1;
  const base: Plan = { ...raw, adjust: null };
  let fresh: Plan | null = null;
  if (o.workouts && raw.built && h) {
    try {
      fresh = buildPlan(base, { ...raw.built }, { ...h, vdot: vNow ?? h.vdot }, today).plan;
    } catch {
      fresh = null;
    }
  }
  let paced = 0;
  let swapped = 0;
  const examples: RefreshResult["examples"] = [];
  const weeks = raw.weeks.map((w) => {
    if (w.start < from) return w;
    const days = forecastWeek(base, w.start).days;
    const sessions = { ...w.sessions };
    days.forEach((d, i) => {
      const k = WEEK_KEYS[i];
      const cur = sessions[k] ?? d.text;
      if (!cur || d.race) return;
      const next = r !== 1 ? scalePaces(cur, r) : cur;
      if (next !== cur) {
        sessions[k] = next;
        paced++;
      }
    });
    if (fresh) {
      const nd = forecastWeek(fresh, w.start).days;
      const newKeys = nd.filter((d) => d.kind === "key" && !d.race).map((d) => d.text);
      let j = 0;
      days.forEach((d, i) => {
        if (d.kind !== "key" || d.race || j >= newKeys.length) return;
        const k = WEEK_KEYS[i];
        const to = newKeys[j++];
        if (to && to !== sessions[k]) {
          if (examples.length < 6) examples.push({ date: d.date, from: sessions[k] ?? d.text, to });
          sessions[k] = to;
          swapped++;
        }
      });
    }
    return { ...w, sessions };
  });
  const paces = r !== 1 ? raw.paces.map((p) => ({ ...p, now: scalePaces(p.now, r) })) : raw.paces;
  const { previous: _prev, ...keep } = raw;
  const plan: Plan = {
    ...raw,
    weeks,
    paces,
    built: raw.built && vNow && o.paces ? { ...raw.built, vdot: vNow } : raw.built,
    previous: keep as Plan,
  };
  return { plan, paced, swapped, examples };
}

/** The plan as plain text, week by week (what's planned now, with your changes). */
export function planText(plan: Plan, overrides?: Map<string, string>): string {
  const out: string[] = [`${plan.title}`, `Exported ${new Date().toISOString().slice(0, 10)} from Pacelife`, ""];
  if (plan.paces.length) out.push("Paces: " + plan.paces.map((p) => `${p.zone} ${p.now}`).join(" · "), "");
  if (plan.races.length) out.push("Races: " + plan.races.map((r) => `${r.date ?? "?"} ${r.name}${r.target ? ` (${r.target})` : ""}`).join(" · "), "");
  for (const w of plan.weeks) {
    const f = forecastWeek(plan, w.start, [], overrides);
    out.push(`Week ${w.week} · ${w.start} · ${w.phase} · ${f.plannedKm != null ? Math.round(f.plannedKm) : w.km} km${w.notes ? ` · ${w.notes}` : ""}`);
    f.days.forEach((d, i) => out.push(`  ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i]} ${d.date.slice(5)}  ${d.race ? `RACE: ${d.race.name}` : d.text || "Rest"}`));
    out.push("");
  }
  return out.join("\n");
}
