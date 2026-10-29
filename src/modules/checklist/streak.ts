import { addDays } from "../../core/time";

/**
 * Current streak: consecutive completed days ending today, or ending yesterday
 * if today isn't done yet (the streak is still alive until the day resets).
 * Best: the longest run ever.
 */
export function streaks(doneDays: Iterable<string>, today: string): { current: number; best: number; alive: boolean } {
  const set = new Set(doneDays);
  let start = set.has(today) ? today : addDays(today, -1);
  let current = 0;
  while (set.has(start)) {
    current++;
    start = addDays(start, -1);
  }
  let best = 0;
  for (const d of set) {
    if (set.has(addDays(d, -1))) continue; // not the start of a run
    let n = 0;
    let k = d;
    while (set.has(k)) {
      n++;
      k = addDays(k, 1);
    }
    best = Math.max(best, n);
  }
  return { current, best, alive: current > 0 };
}
