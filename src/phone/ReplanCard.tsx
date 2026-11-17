import { useMemo, useState, type ReactNode } from "react";
import { addDays, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { loadHealth } from "../modules/health/data";
import { useFitness } from "../modules/running/fitness";
import { firstChangeableMonday, mondayOf, savePlan, type Plan } from "../modules/running/plan";
import { summarizeHistory } from "../modules/running/planBuilder";
import { reasonsKey, replan, replanDiff, replanReasons } from "../modules/running/replan";
import { capCheck, DEFAULT_GAP, fatigueFlags, lighterNextWeek, paceText, racePaceCheck, withRacePace } from "../modules/running/replanChecks";
import { loadDetails } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";

/*
 * Monday re-plan, suggest and confirm (spec step 7). Each suggestion shows only when it applies: it says why,
 * shows what would change, and changes nothing until you confirm. "Not now" hides that suggestion until something
 * new comes up. Today and past days never change.
 */
const KEY = "pacelife.replan.dismissed.v2";
const readDismissed = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.slice(-40) : [];
  } catch {
    return [];
  }
};
const fmt = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const fmtP = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

interface Item {
  key: string;
  title: string;
  why: string[];
  action: string;
  /** Builds the new plan and what to show before confirming. */
  preview: () => { plan: Plan; show: ReactNode } | null;
}

export function ReplanCard() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  const hv = useDataVersion("health");
  const rv = useDataVersion("running");
  const details = useQuery(() => loadDetails(addDays(today, -14)), [rv, today]).data;
  const health = useQuery(() => loadHealth(40), [hv]).data;
  const [dismissed, setDismissed] = useState(readDismissed);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const vNow = f ? (f.predictionBasis?.vdot ?? f.current ?? null) : null;

  const weekKm = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of runs) if (/run/i.test(r.sport)) m.set(mondayOf(r.date), (m.get(mondayOf(r.date)) ?? 0) + r.distance / 1000);
    return m;
  }, [runs]);
  const raw: Plan | null = useMemo(() => (plan ? { ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined } : null), [plan]);

  const items = useMemo((): Item[] => {
    if (!raw?.built) return [];
    const x = { today, vdotNow: vNow, weekKm, history: summarizeHistory(runs, today, vNow) };
    const from = firstChangeableMonday(today);
    const diffTable = (next: Plan) => <DiffTable rows={replanDiff(raw, next, today)} />;
    const out: Item[] = [];

    const reasons = replanReasons(raw, x);
    if (reasons.length)
      out.push({
        key: "replan|" + reasonsKey(reasons, today),
        title: `Re-plan from ${fmt(from)}?`,
        why: reasons.map((r) => r.text),
        action: "Re-plan",
        preview: () => {
          const next = replan(raw, reasons, x);
          return { plan: next, show: diffTable(next) };
        },
      });

    for (const s of racePaceCheck(raw, today, vNow, raw.built.enduranceGap ?? DEFAULT_GAP))
      out.push({
        key: `pace|${s.race}|${s.to}`,
        title: `${s.race}: plan at ${fmtP(s.to)}/km?`,
        why: [paceText(s)],
        action: `Use ${fmtP(s.to)}/km`,
        preview: () => {
          const next = replan(withRacePace(raw, s), [], x);
          return { plan: next, show: <p className="p-start-note">Marathon-pace sessions and long runs from {fmt(s.blockStart)} use {fmtP(s.to)}/km. Your goal time stays as it is.</p> };
        },
      });

    const flags = fatigueFlags({ plan: raw, today, runs, details, health: health ?? [] });
    if (flags.length >= 2)
      out.push({
        key: `fatigue|${mondayOf(today)}|${flags.length}`,
        title: "Ease off next week?",
        why: flags,
        action: "Make next week lighter",
        preview: () => {
          const l = lighterNextWeek(raw, today);
          return {
            plan: l.plan,
            show: (
              <p className="p-start-note">
                {l.week ? `Week of ${fmt(l.week.start)}: ${l.week.from} → ${l.week.to} km (easy runs and the long run shorter). ` : ""}
                {l.dropped ? `${fmt(l.dropped.date)}'s VO2 max session becomes an easy run.` : ""}
              </p>
            ),
          };
        },
      });

    const cap = capCheck(raw, today, weekKm, flags.length);
    if (cap)
      out.push({
        key: `cap|${cap.to}`,
        title: `Raise your volume cap to ${cap.to} km?`,
        why: [`You've held 90% of your ${cap.from} km cap or more for 6 weeks, with no fatigue flags.`],
        action: `Raise to ${cap.to} km`,
        preview: () => {
          const next = replan(raw, [], x, { tune: { ...(raw.built!.tune ?? {}), peakKm: cap.to } });
          return { plan: next, show: diffTable(next) };
        },
      });
    return out;
  }, [raw, today, vNow, weekKm, runs, details, health]);

  const shown = items.filter((i) => !dismissed.includes(i.key));
  const openItem = shown.find((i) => i.key === open) ?? null;
  const pv = useMemo(() => {
    if (!openItem) return null;
    try {
      return openItem.preview();
    } catch {
      return null;
    }
  }, [openItem]);
  if (!shown.length) return null;

  const dismiss = (key: string) => {
    const next = [...dismissed, key];
    try {
      localStorage.setItem(KEY, JSON.stringify(next.slice(-40)));
    } catch {
      /* it just comes back next time */
    }
    setDismissed(next);
    setOpen(null);
  };
  const confirm = async (item: Item) => {
    if (!pv) return;
    setBusy(true);
    setErr(null);
    try {
      await savePlan(pv.plan);
      dismiss(item.key);
    } catch (e) {
      setErr(`Couldn't save the plan: ${e instanceof Error ? e.message : String(e)}. Nothing has changed.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {shown.map((item) => (
        <section key={item.key} className="p-start p-replan" aria-label="Plan suggestion">
          <h2>{item.title}</h2>
          <ul className="p-replan-why">
            {item.why.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          {open === item.key && (
            <>
              {pv ? pv.show : <p className="p-start-note">Couldn't work out the change. Your plan hasn't changed.</p>}
              <p className="p-start-note">Today and the weeks you've done stay as they are. Undo brings the old plan back.</p>
            </>
          )}
          {err && open === item.key && <p className="p-start-note">{err}</p>}
          <div className="p-start-pills">
            {open === item.key ? (
              <button className="p-pill" disabled={busy || !pv} onClick={() => void confirm(item)}>
                {busy ? "Saving…" : item.action}
              </button>
            ) : (
              <button className="p-pill" onClick={() => setOpen(item.key)}>
                See the changes
              </button>
            )}
            <button className="p-pill p-pill-quiet" onClick={() => dismiss(item.key)}>
              Not now
            </button>
          </div>
        </section>
      ))}
    </>
  );
}

function DiffTable({ rows }: { rows: ReturnType<typeof replanDiff> }) {
  return (
    <table className="p-replan-diff num">
      <thead>
        <tr>
          <th>Week of</th>
          <th>Now</th>
          <th>New</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.start}>
            <td>{fmt(d.start)}</td>
            <td>{d.from ?? "–"} km</td>
            <td>
              {d.to ?? "–"} km{d.changed ? <span className="muted"> · {d.changed} {d.changed === 1 ? "day" : "days"} change</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
