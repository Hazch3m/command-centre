import { addDays, diffDays } from "../../core/time";
import { firstChangeableMonday, mondayOf, type Plan } from "./plan";
import { buildPlan, type History } from "./planBuilder";

/*
 * Monday re-plan (plan generator v2 spec, step 7): suggest and confirm, never automatic.
 *
 * Each week the app checks the plan against what's happened. If something has moved enough to matter, it
 * suggests a re-plan, says why, and shows what would change; nothing changes until you confirm. A re-plan
 * builds from the plan's original first Monday with the same choices (so the season, volume and session
 * progressions carry on as before) and replaces only the weeks from the first changeable Monday: the weeks
 * you've done stay, and so does your week count.
 *
 * What triggers a suggestion:
 *  - A race changed since the plan was built: its date moved, an approximate date was fixed, it was removed, or
 *    a new race was added inside the plan. (Checked any day: re-plan when you fix a date.)
 *  - Fitness: your VDOT now is 1.0 or more away from the plan's projection for this week (paces would move by
 *    about 3–4 s/km).
 *  - Missed training: last week was under 70% of its planned km, or the last two weeks were both under 85%.
 *    The re-plan then eases back in: 70% of the planned km the first week (or 10% over what you ran, if more),
 *    85% the second, then the plan.
 * The other checks run once the week has started (Monday on), looking at last week.
 */

export type ReplanKind = "race" | "fitness" | "missed";
export interface ReplanReason {
  kind: ReplanKind;
  text: string;
}
export interface ReplanInput {
  today: string;
  /** Your fitness now (VDOT), if known. */
  vdotNow: number | null;
  /** Km run in each week, by Monday. */
  weekKm: Map<string, number>;
}

const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Why the plan might want a re-plan now (empty: it doesn't). */
export function replanReasons(plan: Plan, x: ReplanInput): ReplanReason[] {
  const b = plan.built;
  if (!b || !b.raceDate || b.raceDate <= x.today) return [];
  const out: ReplanReason[] = [];
  const from = firstChangeableMonday(x.today);

  // Races changed since the build (the build keeps a snapshot of the races it planned around).
  if (plan.vdotTargets) {
    const snap = plan.vdotTargets.filter((t) => t.date >= from && t.date !== b.raceDate);
    const now = plan.races.filter((r) => r.date && r.date >= from && r.date < b.raceDate);
    for (const t of snap) {
      const r = plan.races.find((q) => q.name === t.name);
      if (!r || !r.date) out.push({ kind: "race", text: `${t.name} is no longer in your races.` });
      else if (r.date !== t.date) out.push({ kind: "race", text: `${t.name} moved from ${fmt(t.date)} to ${fmt(r.date)}${r.approx ? " (approximate)" : ""}.` });
      else if (t.approx && !r.approx) out.push({ kind: "race", text: `${t.name}'s date is now fixed: ${fmt(r.date)}.` });
    }
    for (const r of now) if (!plan.vdotTargets.some((t) => t.name === r.name)) out.push({ kind: "race", text: `${r.name} (${fmt(r.date!)}) was added after the plan was built.` });
  }

  const monday = mondayOf(x.today);
  const week = plan.weeks.find((w) => w.start === monday);
  if (week && week.start > b.start) {
    if (x.vdotNow != null && week.vdot != null && Math.abs(x.vdotNow - week.vdot) >= 1) {
      const up = x.vdotNow > week.vdot;
      out.push({ kind: "fitness", text: `Your fitness is VDOT ${x.vdotNow.toFixed(1)}; the plan expected ${week.vdot.toFixed(1)} by now, so its paces are ${up ? "too easy" : "too hard"}.` });
    }
    const ratio = (m: string) => {
      const w = plan.weeks.find((q) => q.start === m);
      const p = w?.kmMin ?? null;
      return w && p && p > 0 && m >= b.start ? (x.weekKm.get(m) ?? 0) / p : null;
    };
    const r1 = ratio(addDays(monday, -7));
    const r2 = ratio(addDays(monday, -14));
    if (r1 != null && (r1 < 0.7 || (r1 < 0.85 && r2 != null && r2 < 0.85))) {
      const last = plan.weeks.find((q) => q.start === addDays(monday, -7))!;
      out.push({ kind: "missed", text: `Last week was ${Math.round(x.weekKm.get(last.start) ?? 0)} of ${last.kmMin} km${r1 >= 0.7 ? ", the second short week in a row" : ""}: the next two weeks would ease back in.` });
    }
  }
  return out;
}

/** A key for the reasons, so a dismissed suggestion comes back only when something new happens. */
export const reasonsKey = (rs: ReplanReason[], today: string) => `${mondayOf(today)}|${rs.map((r) => r.text).join("|")}`;

/** The re-planned plan (not saved): the same choices, from the first changeable Monday. */
export function replan(plan: Plan, rs: ReplanReason[], x: ReplanInput & { history: History }): Plan {
  const b = plan.built!;
  const missed = rs.some((r) => r.kind === "missed");
  const lastKm = x.weekKm.get(addDays(mondayOf(x.today), -7)) ?? 0;
  const { start: _s, peak: _p, longest: _l, vdot, vdotEnd: _e, history, weeks: _w, ...opts } = b;
  // The original history and fitness, so the season and volume come out as before; then today's fitness moves the
  // paces from here on.
  const h = { ...(history ?? x.history), vdot };
  const weeks = diffDays(b.start, mondayOf(b.raceDate)) / 7 + 1;
  return buildPlan(
    plan,
    {
      ...opts,
      weeks,
      // Races are as they are now (the plan's own list, edits already in it).
      raceEdits: undefined,
      keepRaces: true,
      extraRaces: [],
      anchorStart: b.start,
      vdotNow: x.vdotNow ?? undefined,
      resumeKm: missed ? Math.max(20, lastKm) : undefined,
    },
    h,
    x.today,
  ).plan;
}

/** What a re-plan changes in the next few weeks, for the confirmation: km before and after, week by week. */
export function replanDiff(before: Plan, after: Plan, today: string, n = 4): { start: string; from: number | null; to: number | null; changed: number }[] {
  const from = firstChangeableMonday(today);
  return after.weeks
    .filter((w) => w.start >= from)
    .slice(0, n)
    .map((w) => {
      const old = before.weeks.find((q) => q.start === w.start);
      const changed = old ? Object.keys({ ...old.sessions, ...w.sessions }).filter((k) => (old.sessions as Record<string, string>)[k] !== (w.sessions as Record<string, string>)[k]).length : 7;
      return { start: w.start, from: old?.kmMin ?? null, to: w.kmMin ?? null, changed };
    });
}
