import { useEffect, useMemo, useState } from "react";
import { parseKey, useToday } from "../../core/time";
import { ErrorNote } from "../../shell/ui";
import { raceKm } from "./forecast";
import { priorityOf, savePlanRaces, type Plan, type PlanRace, type RacePriority } from "./plan";
import { applyAdjust, applyRaceTapers } from "./planAdjust";
import { raceReadiness, readinessTone } from "./readiness";
import { ReadinessView, useReadinessInputs } from "./Readiness";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (d: string) => `${DOW[parseKey(d).getDay()]} ${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const DISTANCES = [
  { km: 5, l: "5k" },
  { km: 10, l: "10k" },
  { km: 21.1, l: "Half" },
  { km: 42.2, l: "Marathon" },
];
const PRIORITY: Record<RacePriority, string> = { A: "Goal race: everything builds to it", B: "Race it well, without derailing the plan", C: "Training race or time trial" };
const TAPER = [
  { v: "plan", l: "As the plan has it", sub: "Keep the weeks as written" },
  { v: "full", l: "Full taper", sub: "1–3 weeks easing off, by distance" },
  { v: "mini", l: "Mini taper", sub: "Easier race week, no hard days in the last 3" },
  { v: "none", l: "Train through", sub: "Only the race day changes" },
] as const;
const defaultTaper = (p: RacePriority) => (p === "A" ? "full" : p === "B" ? "mini" : "none");

/**
 * Your races: dates, distances, goals, how much each matters (A/B/C) and how
 * the plan eases off for it. Starts from the races in your plan; changes are
 * saved together, and each upcoming race shows how ready the plan gets you.
 */
export function RaceManager({ plan }: { plan: Plan }) {
  const today = useToday();
  const [draft, setDraft] = useState<PlanRace[]>(plan.races);
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(plan.races);
  }, [plan, dirty]);
  const change = (i: number, patch: Partial<PlanRace>) => {
    setDraft((d) => d.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  // The plan as it would be with these races and tapers, for readiness.
  const { actual, vdotAt, ready } = useReadinessInputs(plan);
  const preview = useMemo(() => {
    const written: Plan = { ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined, races: draft };
    try {
      return applyRaceTapers(applyAdjust(written));
    } catch {
      return written;
    }
  }, [plan, draft]);
  const scores = useMemo(
    () => (ready ? draft.map((r) => (r.date && r.date >= today && !r.approx ? raceReadiness(preview, r, today, vdotAt, actual) : null)) : []),
    [preview, draft, today, vdotAt, actual, ready],
  );

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await savePlanRaces(draft.filter((r) => r.name.trim()));
      setDirty(false);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setDraft((d) => [...d, { date: today, approx: false, when: "", name: "", target: "", role: "", priority: "B", taper: "mini" }]);
    setDirty(true);
    setOpen(draft.length);
  };
  const rows = draft.map((r, i) => ({ r, i })).filter(({ r }) => past || !r.date || r.date >= today);
  const hidden = draft.length - rows.length;

  return (
    <div className="race-manager">
      <div className="rm-intro muted small">
        <b>A</b> races are what the plan builds to; <b>B</b> races you want to run well; <b>C</b> races are training. Pick how the plan eases off for each one. Tap a race for its
        readiness.
      </div>
      {rows.map(({ r, i }) => {
        const p = priorityOf(r);
        const k = r.km ?? raceKm(r.name);
        const s = scores[i];
        const isOpen = open === i;
        return (
          <section key={i} className={"rm-race" + (isOpen ? " open" : "") + ` pr-${p}`}>
            <button className="rm-summary" onClick={() => setOpen(isOpen ? null : i)}>
              <span className={"rm-pri pr-" + p}>{p}</span>
              <span className="rm-name">
                <b>{r.name || "New race"}</b>
                <span className="muted small">
                  {r.date ? (r.approx ? `${r.when || "Date to confirm"}` : when(r.date)) : "No date"}
                  {k ? ` · ${k} km` : ""}
                  {r.target ? ` · ${r.target}` : ""}
                  {" · "}
                  {TAPER.find((t) => t.v === (r.taper ?? "plan"))!.l.toLowerCase()}
                </span>
              </span>
              {s && <span className={"rm-score num " + readinessTone(s.score)}>{s.score}%</span>}
              <span className="p-chev">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen && (
              <div className="rm-edit">
                <div className="pb-fields">
                  <label>
                    <span className="label">Name</span>
                    <input value={r.name} placeholder="e.g. Berlin Half" onChange={(e) => change(i, { name: e.target.value })} />
                  </label>
                  <label>
                    <span className="label">Date</span>
                    <input type="date" value={r.date ?? ""} onChange={(e) => change(i, { date: e.target.value || null, approx: false, when: e.target.value ? when(e.target.value) : "" })} />
                  </label>
                  <label>
                    <span className="label">Goal</span>
                    <input value={r.target} placeholder="1:18:00" onChange={(e) => change(i, { target: e.target.value })} />
                  </label>
                </div>
                <div className="rm-row">
                  <span className="label">Distance</span>
                  <div className="ps-choice">
                    {DISTANCES.map((d) => (
                      <button key={d.km} type="button" className={k != null && Math.abs(k - d.km) < 0.5 ? "on" : ""} onClick={() => change(i, { km: d.km })}>
                        {d.l}
                      </button>
                    ))}
                    <input className="rm-km" type="number" min={1} max={100} step={0.1} value={k ?? ""} onChange={(e) => change(i, { km: e.target.value ? +e.target.value : undefined })} aria-label="Distance in km" />
                    <span className="muted small">km</span>
                  </div>
                </div>
                <div className="rm-row">
                  <span className="label">Priority</span>
                  <div className="ps-choice">
                    {(["A", "B", "C"] as RacePriority[]).map((x) => (
                      <button key={x} type="button" className={p === x ? "on" : ""} title={PRIORITY[x]} onClick={() => change(i, { priority: x, taper: r.taper ?? defaultTaper(x) })}>
                        {x} race
                      </button>
                    ))}
                  </div>
                  <span className="muted small">{PRIORITY[p]}</span>
                </div>
                <div className="rm-row">
                  <span className="label">Taper</span>
                  <div className="rm-tapers">
                    {TAPER.map((t) => (
                      <button key={t.v} type="button" className={(r.taper ?? "plan") === t.v ? "on" : ""} onClick={() => change(i, { taper: t.v === "plan" ? undefined : t.v })}>
                        <b>{t.l}</b>
                        <small>{t.sub}</small>
                      </button>
                    ))}
                  </div>
                </div>
                {s && <ReadinessView r={s} />}
                <div className="rm-actions">
                  <button
                    className="btn ghost"
                    onClick={() => {
                      if (armed !== i) {
                        setArmed(i);
                        window.setTimeout(() => setArmed(null), 4000);
                        return;
                      }
                      setDraft((d) => d.filter((_, j) => j !== i));
                      setDirty(true);
                      setOpen(null);
                      setArmed(null);
                    }}
                  >
                    {armed === i ? "Tap again to remove" : "Remove race"}
                  </button>
                </div>
              </div>
            )}
          </section>
        );
      })}
      <div className="rm-foot">
        <button className="btn" onClick={add}>
          + Add a race
        </button>
        {hidden > 0 || past ? (
          <button className="btn ghost small" onClick={() => setPast((x) => !x)}>
            {past ? "Hide past races" : `Show ${hidden} past race${hidden === 1 ? "" : "s"}`}
          </button>
        ) : null}
        <span className="spacer" />
        {dirty && (
          <button className="btn ghost" onClick={() => (setDraft(plan.races), setDirty(false))}>
            Undo changes
          </button>
        )}
        <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
          {busy ? "Saving…" : dirty ? "Save races" : "Saved"}
        </button>
      </div>
      {plan.built && dirty && (
        <p className="ps-note">Your plan was built for {plan.built.raceName}. Tapers apply straight away; to fit a new A race into the plan, rebuild it in Build a plan.</p>
      )}
      <ErrorNote error={err} />
    </div>
  );
}
