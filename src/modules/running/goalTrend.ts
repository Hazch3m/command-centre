import { useEffect, useState } from "react";
import { db, kvGet, kvSet } from "../../core/db";
import { addDays, todayKey } from "../../core/time";

/**
 * A daily note of each goal's "now" and "race day" times, so a card can say what changed:
 * "−0:12 since Mon" after a session that moved them. One entry a day per goal (the latest of the day).
 */
interface Snap {
  date: string;
  now: number | null;
  day: number | null;
}
const KEY = "goals.snap";
let cache: Promise<Record<string, Snap[]>> | null = null;
const load = () => (cache ??= kvGet<Record<string, Snap[]>>(KEY, {}).then((v) => v ?? {}));
let writing: ReturnType<typeof setTimeout> | null = null;

export interface Trend {
  now: number | null;
  day: number | null;
  /** The date the earlier values are from. */
  since: string;
}

const round = (v: number | null) => (v == null ? null : Math.round(v));

/** Change in the goal's times since they were last different (on an earlier day). */
export function useGoalTrend(id: string, now: number | null, day: number | null, km?: number): Trend | null {
  const [t, setT] = useState<Trend | null>(null);
  useEffect(() => {
    if (now == null && day == null) return;
    let live = true;
    void load().then(async (all) => {
      if (!live) return;
      const today = todayKey();
      const list = (all[id] ?? []).filter((s) => s.date < today);
      const n = round(now);
      const d = round(day);
      // The last earlier day whose times differ from today's: that's the change to show.
      const prev = [...list].reverse().find((s) => (s.now != null && n != null && Math.abs(s.now - n) >= 2) || (s.day != null && d != null && Math.abs(s.day - d) >= 2));
      const base = prev ?? null;
      if (base) setT({ now: n != null && base.now != null ? n - base.now : null, day: d != null && base.day != null ? d - base.day : null, since: nextAfter(list, base.date) ?? today });
      else if (!list.length && km) {
        // No history kept yet: use how Garmin's prediction for this distance moved today.
        const name = Math.abs(km - 5) < 0.3 ? "5K" : Math.abs(km - 10) < 0.4 ? "10K" : Math.abs(km - 21.1) < 0.5 ? "Half" : Math.abs(km - 42.2) < 0.8 ? "Marathon" : null;
        const ch = name ? (await predictionChange(today)).find((x) => x.name === name) : null;
        if (live && ch) {
          const ratio = ch.after / ch.before;
          setT({ now: n != null ? n - n / ratio : null, day: d != null ? d - d / ratio : null, since: today });
        }
      }
      // Record today's values (replacing today's entry), keeping 120 days.
      const todayEntry = (all[id] ?? []).find((s) => s.date === today);
      if (todayEntry && todayEntry.now === n && todayEntry.day === d) return;
      all[id] = [...list.filter((s) => s.date >= addDays(today, -120)), { date: today, now: n, day: d }];
      if (writing) clearTimeout(writing);
      writing = setTimeout(() => void kvSet(KEY, all).catch(() => {}), 1500);
    });
    return () => {
      live = false;
    };
  }, [id, now, day]);
  return t;
}

/** The day after `date` that has an entry (when the change happened), if any. */
function nextAfter(list: Snap[], date: string): string | null {
  const i = list.findIndex((s) => s.date === date);
  return i >= 0 && list[i + 1] ? list[i + 1].date : null;
}

/** Garmin's race predictions on the day of a run against the day before it had any: how the run moved them. */
export async function predictionChange(date: string): Promise<{ name: string; before: number; after: number }[]> {
  type Row = { date: string; pred_5k: number | null; pred_10k: number | null; pred_half: number | null; pred_marathon: number | null };
  const cols = "date, pred_5k, pred_10k, pred_half, pred_marathon";
  const [after] = await db.select<Row>(`SELECT ${cols} FROM health_daily WHERE pred_10k IS NOT NULL AND date >= ? AND date <= ? ORDER BY date LIMIT 1`, [date, addDays(date, 1)]).catch(() => [] as Row[]);
  const [before] = await db.select<Row>(`SELECT ${cols} FROM health_daily WHERE pred_10k IS NOT NULL AND date < ? ORDER BY date DESC LIMIT 1`, [date]).catch(() => [] as Row[]);
  if (!after || !before || before.date < addDays(date, -10)) return [];
  const out: { name: string; before: number; after: number }[] = [];
  for (const [k, name] of [
    ["pred_5k", "5K"],
    ["pred_10k", "10K"],
    ["pred_half", "Half"],
    ["pred_marathon", "Marathon"],
  ] as const) {
    const a = after[k];
    const b = before[k];
    if (a && b && Math.abs(a - b) >= 1) out.push({ name, before: b, after: a });
  }
  return out;
}
