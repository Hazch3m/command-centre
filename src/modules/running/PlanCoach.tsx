import { useMemo, useState } from "react";
import { useDataVersion } from "../../core/events";
import { addDays, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { mondayOf, savePlanAdjust, savePlanChanges, type Plan } from "./plan";
import { ADJUST_DEFAULTS, nextMonday } from "./planAdjust";
import { planAdvice, RECOVERY_LABEL, type Advice, type RecoveryMode } from "./planChanges";
import { usePaceChecks } from "./PaceOnPoint";
import { loadOverrides } from "./strava";
import { useRunningData } from "./useRunning";

const fmt = (d: string) => new Date(d + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/**
 * Plan check, like Runna's adaptive plan: how the last three weeks went
 * (mileage run, sessions missed, Pace on point) and what to change, with one tap.
 * Also: make a week easier or a rest week, and recovery mode when injured or ill.
 */
export function PlanCoach({ plan, monday, compact }: { plan: Plan; monday?: string; compact?: boolean }) {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const checks = usePaceChecks(plan, runs, 4);
  const advice = useMemo(() => (checks ? planAdvice(plan, runs, checks.rows, today, overrides) : []), [plan, runs, checks, today, overrides]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const apply = (a: Advice["actions"][number]) =>
    run(async () => {
      if ("volume" in a.change) await savePlanAdjust({ ...ADJUST_DEFAULTS, ...(plan.adjust ?? {}), volume: a.change.volume, from: nextMonday(today) });
      else await savePlanChanges(a.change);
    });
  const dismiss = (id: string) => run(() => savePlanChanges({ dismissed: [...(plan.changes?.dismissed ?? []), id].slice(-30) }));
  const shift = plan.changes?.pace?.shift ?? 0;

  return (
    <div className={"plan-coach" + (compact ? " compact" : "")}>
      {advice.map((a) => (
        <div key={a.id} className={`pc-advice pc-${a.tone}`}>
          <div className="pc-head">
            <b>{a.title}</b>
            <button type="button" className="link-btn small" onClick={() => dismiss(a.id)} aria-label="Dismiss">
              {a.tone === "good" && !a.actions.length ? "OK" : "Not now"}
            </button>
          </div>
          <p>{a.text}</p>
          {a.actions.length > 0 && (
            <div className="inline">
              {a.actions.map((x, i) => (
                <button key={x.label} type="button" className={"btn small" + (i === 0 ? " btn-primary" : "")} disabled={busy} onClick={() => apply(x)}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {shift !== 0 && (
        <div className="pc-note small">
          Pace targets {shift < 0 ? `${-shift} s/km faster` : `${shift} s/km slower`} than planned since {fmt(plan.changes!.pace!.from)}.{" "}
          <button type="button" className="link-btn" disabled={busy} onClick={() => run(() => savePlanChanges({ pace: null }))}>
            Back to the plan's paces
          </button>
        </div>
      )}
      <WeekTools plan={plan} monday={monday ?? mondayOf(today)} busy={busy} run={run} />
      <Recovery plan={plan} busy={busy} run={run} />
      {err && <div className="error-note small">{err}</div>}
    </div>
  );
}

function WeekTools({ plan, monday, busy, run }: { plan: Plan; monday: string; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const mode = plan.changes?.weeks?.[monday] ?? null;
  const set = (m: "easier" | "rest" | null) => run(() => savePlanChanges({ weeks: { ...(plan.changes?.weeks ?? {}), [monday]: m as "easier" } }));
  return (
    <div className="pc-row">
      <span className="pc-label">Week of {fmt(monday)}</span>
      <div className="ps-choice">
        {(
          [
            [null, "As planned"],
            ["easier", "Easier week"],
            ["rest", "Rest week"],
          ] as const
        ).map(([m, l]) => (
          <button key={l} type="button" className={mode === m ? "on" : ""} disabled={busy} onClick={() => set(m)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

function Recovery({ plan, busy, run }: { plan: Plan; busy: boolean; run: (fn: () => Promise<unknown>) => void }) {
  const today = useToday();
  const rec = plan.changes?.recovery ?? null;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RecoveryMode["mode"]>("return");
  const [weeks, setWeeks] = useState<number | null>(2);
  const active = rec && (!rec.weeks || addDays(rec.from, rec.weeks * 7) > today);
  if (active)
    return (
      <div className="pc-advice pc-warn">
        <div className="pc-head">
          <b>Recovery mode: {RECOVERY_LABEL[rec!.mode].toLowerCase()}</b>
        </div>
        <p>
          Since {fmt(rec!.from)}
          {rec!.weeks ? `, for ${rec!.weeks} week${rec!.weeks === 1 ? "" : "s"} (until ${fmt(addDays(rec!.from, rec!.weeks * 7))})` : ", until you end it"}. No sessions; the plan picks up after it.
        </p>
        <div className="inline">
          {rec!.mode !== "return" && (
            <button type="button" className="btn small" disabled={busy} onClick={() => run(() => savePlanChanges({ recovery: { ...rec!, mode: "return" } }))}>
              Start easy running
            </button>
          )}
          <button type="button" className="btn small btn-primary" disabled={busy} onClick={() => run(() => savePlanChanges({ recovery: null }))}>
            I'm better: back to the plan
          </button>
        </div>
      </div>
    );
  if (!open)
    return (
      <button type="button" className="link-btn small pc-injured" onClick={() => setOpen(true)}>
        Injured or ill? Recovery mode
      </button>
    );
  return (
    <div className="pc-advice pc-info">
      <div className="pc-head">
        <b>Recovery mode</b>
      </div>
      <p>Replaces the plan's runs from this week: no sessions, the plan carries on afterwards. See a professional if pain is sharp, gets worse or lasts.</p>
      <div className="ps-choice">
        {(["rest", "cross", "return"] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
            {RECOVERY_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="ps-choice">
        {([1, 2, 3, 4, 6, null] as const).map((w) => (
          <button key={String(w)} type="button" className={weeks === w ? "on" : ""} onClick={() => setWeeks(w)}>
            {w ? `${w} week${w === 1 ? "" : "s"}` : "Until I'm better"}
          </button>
        ))}
      </div>
      <div className="inline">
        <button type="button" className="btn small btn-primary" disabled={busy} onClick={() => run(async () => (await savePlanChanges({ recovery: { from: mondayOf(today), weeks, mode } }), setOpen(false)))}>
          Start recovery
        </button>
        <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
