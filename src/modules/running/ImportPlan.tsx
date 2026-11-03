import { useMemo, useState } from "react";
import { parseKey, useToday } from "../../core/time";
import { BarChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { forecastWeek } from "./forecast";
import { restorePreviousPlan, savePlan, WEEK_KEYS, type Plan, type PlanRace } from "./plan";
import { CSV_TEMPLATE_DAYS, CSV_TEMPLATE_WEEKS, csvToWeeks, mergeImported, type CsvPlan } from "./planCsv";
import { raceReadiness } from "./readiness";
import { ReadinessView, useReadinessInputs } from "./Readiness";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]} ${parseKey(d).getFullYear()}`;
const DAY_SHORT = ["M", "T", "W", "T", "F", "S", "S"];
const DISTANCES = [
  { km: 5, l: "5k" },
  { km: 10, l: "10k" },
  { km: 21.1, l: "Half" },
  { km: 42.2, l: "Marathon" },
];
const guessKm = (t: string, km: number | null) => km ?? (/half/i.test(t) ? 21.1 : /marathon/i.test(t) ? 42.2 : /10\s*k/i.test(t) ? 10 : /5\s*k|parkrun/i.test(t) ? 5 : null);

/**
 * Bring in a plan from a CSV (a coach's spreadsheet, another app's export):
 * see how ready it gets you for the race, compared with your current plan,
 * then switch to it if you like. Your current plan is kept.
 */
export function ImportPlan({ plan, compact }: { plan: Plan; compact?: boolean }) {
  const today = useToday();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("your CSV");
  const [showTemplate, setShowTemplate] = useState(false);
  const [race, setRace] = useState<{ name: string; date: string; km: number | null; target: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { actual, vdotAt, ready } = useReadinessInputs(plan);

  const parsed = useMemo((): { ok: CsvPlan } | { error: string } | null => {
    if (!text.trim()) return null;
    try {
      return { ok: csvToWeeks(text) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [text]);
  const imp = parsed && "ok" in parsed ? parsed.ok : null;
  // The goal race: picked by you, else the last race-looking row.
  const goal = race ?? (imp?.raceRows.length ? (() => {
    const r = imp.raceRows[imp.raceRows.length - 1];
    return { name: r.text, date: r.date, km: guessKm(r.text, r.km), target: "" };
  })() : null);
  const goalRace: PlanRace | null = goal?.date ? { date: goal.date, approx: false, when: "", name: goal.name || "Goal race", target: goal.target, role: "Goal race", priority: "A", km: goal.km ?? undefined } : null;
  const base: Plan = useMemo(() => ({ ...plan, weeks: plan.baseWeeks ?? plan.weeks, baseWeeks: undefined }), [plan]);
  const merged = useMemo(() => (imp ? mergeImported(base, imp, goalRace, fileName, today) : null), [imp, base, goalRace?.date, goalRace?.name, goalRace?.km, goalRace?.target, fileName, today]);
  const rNew = useMemo(() => (merged && goalRace && ready ? raceReadiness(merged, goalRace, today, vdotAt, actual) : null), [merged, ready, vdotAt, actual, today]);
  const rOld = useMemo(() => (goalRace && ready ? raceReadiness(plan, goalRace, today, vdotAt, actual) : null), [plan, goalRace?.date, goalRace?.km, goalRace?.target, ready, vdotAt, actual, today]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    setText(await f.text());
    setRace(null);
    setDone(null);
  };
  const use = async () => {
    if (!merged) return;
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 5000);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await savePlan(merged);
      setDone(`Your plan now follows ${fileName}.`);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div className={"import-plan" + (compact ? " compact" : "")}>
      <section className="ps-card">
        <h4>Import a plan from a CSV</h4>
        <p className="ps-note">
          From a coach, a spreadsheet or another app. One row per day (<code>date, workout, distance_km</code>) or one row per week (<code>week_start, mon … sun</code>). Distances in
          the workout text ("12 km easy", "5 × 1 km at 3:30") are understood too.
        </p>
        <div className="ip-pick">
          <label className="btn btn-primary">
            Choose a CSV file
            <input type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <span className="muted small">or paste it below</span>
          <button className="btn ghost small" onClick={() => setShowTemplate((x) => !x)}>
            {showTemplate ? "Hide examples" : "Show examples"}
          </button>
        </div>
        {showTemplate && (
          <div className="ip-templates">
            {[
              { t: "One row per day", csv: CSV_TEMPLATE_DAYS },
              { t: "One row per week", csv: CSV_TEMPLATE_WEEKS },
            ].map((x) => (
              <div key={x.t}>
                <div className="ip-template-head">
                  <b className="small">{x.t}</b>
                  <button className="btn ghost small" onClick={() => (setText(x.csv), setFileName("the example"), setRace(null))}>
                    Try it
                  </button>
                  <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(x.csv)}>
                    Copy
                  </button>
                </div>
                <pre>{x.csv}</pre>
              </div>
            ))}
          </div>
        )}
        <textarea className="ip-paste" rows={compact ? 4 : 5} value={text} placeholder="date,workout,distance_km" onChange={(e) => (setText(e.target.value), setFileName("the pasted plan"), setDone(null))} />
        {parsed && "error" in parsed && <ErrorNote error={parsed.error} />}
        {imp?.warnings.map((w) => (
          <p key={w} className="ps-note">
            ⚠ {w}
          </p>
        ))}
      </section>

      {imp && merged && (
        <>
          <section className="ps-card">
            <h4>The race</h4>
            {imp.raceRows.length > 0 && (
              <div className="ps-choice">
                {imp.raceRows.map((r) => (
                  <button
                    key={r.date + r.text}
                    type="button"
                    className={goal?.date === r.date && goal?.name === r.text ? "on" : ""}
                    onClick={() => setRace({ name: r.text, date: r.date, km: guessKm(r.text, r.km), target: goal?.target ?? "" })}
                  >
                    {r.text} · {fmt(r.date)}
                  </button>
                ))}
              </div>
            )}
            <div className="pb-fields">
              <label>
                <span className="label">Name</span>
                <input value={goal?.name ?? ""} placeholder="Goal race" onChange={(e) => setRace({ ...(goal ?? { date: imp.weeks[imp.weeks.length - 1].end, km: 42.2, target: "" }), name: e.target.value })} />
              </label>
              <label>
                <span className="label">Date</span>
                <input type="date" value={goal?.date ?? ""} onChange={(e) => setRace({ ...(goal ?? { name: "Goal race", km: 42.2, target: "" }), date: e.target.value })} />
              </label>
              <label>
                <span className="label">Goal time</span>
                <input value={goal?.target ?? ""} placeholder="2:59" onChange={(e) => setRace({ ...(goal ?? { name: "Goal race", date: imp.weeks[imp.weeks.length - 1].end, km: 42.2 }), target: e.target.value })} />
              </label>
            </div>
            <div className="ps-choice">
              {DISTANCES.map((d) => (
                <button key={d.km} type="button" className={goal?.km === d.km ? "on" : ""} onClick={() => setRace({ ...(goal ?? { name: "Goal race", date: imp.weeks[imp.weeks.length - 1].end, target: "" }), km: d.km })}>
                  {d.l}
                </button>
              ))}
            </div>
          </section>

          <section className="ps-card ps-preview">
            <div className="ps-preview-head">
              <h4>The imported plan</h4>
              <span className="ps-sub">
                {imp.weeks.length} weeks · {fmt(imp.weeks[0].start)} → {fmt(imp.weeks[imp.weeks.length - 1].end)}
              </span>
            </div>
            {rNew ? (
              <div className="ip-compare">
                <ReadinessView r={rNew} compact={compact} />
                {rOld && (
                  <div className="ip-old muted small">
                    Your current plan for the same race: <b className="num">{rOld.score}%</b> ready
                    {rOld.predicted && rNew.predicted ? ` · predicted ${Math.round((rOld.predicted - rNew.predicted) / 60) > 0 ? `${Math.round((rOld.predicted - rNew.predicted) / 60)} min slower` : Math.round((rOld.predicted - rNew.predicted) / 60) < 0 ? `${Math.round((rNew.predicted - rOld.predicted) / 60)} min faster` : "about the same"} than this one` : ""}
                    .
                  </div>
                )}
              </div>
            ) : (
              <p className="ps-note">{goalRace ? "Working out readiness…" : "Pick or enter the race to see how ready this plan gets you."}</p>
            )}
            <BarChart
              bars={imp.weeks.map((w) => ({
                label: parseKey(w.start).getDate() <= 7 ? MON[parseKey(w.start).getMonth()] : "",
                value: forecastWeek(merged, w.start).plannedKm ?? 0,
                title: `Week of ${fmt(w.start)}`,
              }))}
              height={compact ? 120 : 150}
              unit=" km"
              showValues={!compact}
            />
            <details className="fold">
              <summary>Week by week</summary>
              <div className="pb-weeks">
                {imp.weeks.map((w) => (
                  <div key={w.start} className="pb-week">
                    <div className="pb-week-head">
                      <b>Week {w.week}</b> <span className="muted">{fmt(w.start)}</span>
                      <span className="num">{forecastWeek(merged, w.start).plannedKm} km</span>
                    </div>
                    <div className="pb-days">
                      {WEEK_KEYS.map((k, i) => (
                        <span key={k} className={/^rest$/i.test(w.sessions[k] ?? "") ? "rest" : ""}>
                          <i>{DAY_SHORT[i]}</i>
                          {w.sessions[k]}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </section>

          <div className="ps-actions">
            <button className="btn btn-primary" disabled={busy} onClick={use}>
              {busy ? "Saving…" : armed ? "Tap again to switch to this plan" : "Use this plan"}
            </button>
            {plan.previous && (
              <button className="btn" disabled={busy} onClick={() => restorePreviousPlan().then(() => setDone("Your previous plan is back."))}>
                Bring back my previous plan
              </button>
            )}
            <span className="ps-note">Replaces your plan for these weeks only; your current plan is kept so you can bring it back.</span>
          </div>
          {done && <div className="pb-done">{done}</div>}
          <ErrorNote error={err} />
        </>
      )}
    </div>
  );
}
