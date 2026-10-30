import { useEffect, useState } from "react";
import { addDays, useToday } from "../../core/time";
import { ErrorNote } from "../../shell/ui";
import { PlanCalendarSync } from "./planCalendar";
import { resetPlan, savePlan, type Plan, type PlanRace, type PlanWeek } from "./plan";

const DAYS = ["tue", "wed", "thu", "sun"] as const;
const DAY_LABEL: Record<(typeof DAYS)[number], string> = { tue: "Tuesday", wed: "Wednesday", thu: "Thursday", sun: "Sunday" };

/**
 * Edit the plan itself: weeks, sessions, races and the weekly structure. Saved
 * here, it becomes the master copy: the training calendar, weekly targets,
 * pace on point and (if switched on) your Google Calendar follow it.
 */
export function PlanEditor({ plan }: { plan: Plan }) {
  const today = useToday();
  const [draft, setDraft] = useState<Plan>(plan);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(plan);
  }, [plan, dirty]);

  const change = (fn: (p: Plan) => Plan) => {
    setDraft((p) => fn(structuredClone(p)));
    setDirty(true);
  };
  const setWeek = (i: number, patch: Partial<PlanWeek>) =>
    change((p) => {
      p.weeks[i] = { ...p.weeks[i], ...patch };
      return p;
    });
  const setSession = (i: number, day: (typeof DAYS)[number], text: string) =>
    change((p) => {
      const s = { ...p.weeks[i].sessions };
      if (text.trim()) s[day] = text;
      else delete s[day];
      p.weeks[i] = { ...p.weeks[i], sessions: s };
      return p;
    });
  const addWeekAfter = (i: number) =>
    change((p) => {
      const w = p.weeks[i];
      const start = addDays(w.start, 7);
      const n: PlanWeek = { week: String(Number(w.week) + 1 || `${w.week}+`), start, end: addDays(start, 6), phase: w.phase, km: w.km, kmMin: w.kmMin, kmMax: w.kmMax, sessions: { ...w.sessions }, notes: "" };
      // Later weeks move back a week.
      for (let j = i + 1; j < p.weeks.length; j++) p.weeks[j] = { ...p.weeks[j], start: addDays(p.weeks[j].start, 7), end: addDays(p.weeks[j].end, 7) };
      p.weeks.splice(i + 1, 0, n);
      return p;
    });
  const removeWeek = (i: number) =>
    change((p) => {
      for (let j = i + 1; j < p.weeks.length; j++) p.weeks[j] = { ...p.weeks[j], start: addDays(p.weeks[j].start, -7), end: addDays(p.weeks[j].end, -7) };
      p.weeks.splice(i, 1);
      return p;
    });
  const setRace = (i: number, patch: Partial<PlanRace>) =>
    change((p) => {
      p.races[i] = { ...p.races[i], ...patch };
      return p;
    });
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      draft.races.sort((a, b) => (a.date ?? "9").localeCompare(b.date ?? "9"));
      await savePlan(draft);
      setDirty(false);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const visible = draft.weeks.map((w, i) => ({ w, i })).filter(({ w }) => showPast || w.end >= addDays(today, -7));
  return (
    <div className="plan-editor">
      <div className="plan-save-bar">
        <span className="small muted">
          {draft.editedInApp
            ? `Edited here (last saved ${new Date(draft.editedInApp).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}). This is now the master copy.`
            : "This is the plan from your training doc. Once you save a change here, the app's copy becomes the master."}
        </span>
        <span className="inline">
          {draft.editedInApp && (
            <button
              className="btn"
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  window.setTimeout(() => setArmed(false), 4000);
                  return;
                }
                setArmed(false);
                resetPlan().then(() => setDirty(false));
              }}
            >
              {armed ? "Click again to throw away your edits" : "Go back to the doc's plan"}
            </button>
          )}
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>
            {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>
        </span>
      </div>
      <ErrorNote error={err} />

      <PlanCalendarSync />

      <h3>Weeks</h3>
      <p className="muted small">
        Sessions written the way the plan does them ("12 km easy", "5 × 1 km at 3:20, 2 min jog", "28 km, last 6 at 4:05") get distances and paces worked out. Days left empty
        follow the weekly structure below. Adding or removing a week moves the later weeks.
      </p>
      <label className="inline small">
        <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> Show past weeks
      </label>
      <div className="plan-weeks">
        {visible.map(({ w, i }) => (
          <div key={`${w.start}-${i}`} className={"plan-week" + (w.start <= today && today <= w.end ? " now" : "")}>
            <div className="plan-week-head">
              <input className="pw-label" value={w.week} onChange={(e) => setWeek(i, { week: e.target.value })} aria-label="Week" />
              <span className="muted small">
                {w.start} → {addDays(w.start, 6)}
              </span>
              <label className="small">
                km <input className="pw-km" value={w.km} onChange={(e) => setWeek(i, { km: e.target.value })} aria-label="Weekly km" />
              </label>
              <input className="pw-phase" value={w.phase} onChange={(e) => setWeek(i, { phase: e.target.value })} aria-label="Phase" title="Phase (include 'Phase 3' for marathon-specific structure)" />
              <span className="pw-actions">
                <button className="btn icon ghost" onClick={() => addWeekAfter(i)} title="Insert a week after this one">
                  +
                </button>
                <button className="btn icon ghost" onClick={() => removeWeek(i)} title="Remove this week">
                  ✕
                </button>
              </span>
            </div>
            <div className="plan-week-days">
              {DAYS.map((d) => (
                <label key={d}>
                  <span className="label">{DAY_LABEL[d]}</span>
                  <input value={w.sessions[d] ?? ""} onChange={(e) => setSession(i, d, e.target.value)} placeholder="from the structure" />
                </label>
              ))}
              <label>
                <span className="label">Notes</span>
                <input value={w.notes} onChange={(e) => setWeek(i, { notes: e.target.value })} />
              </label>
            </div>
          </div>
        ))}
      </div>

      <h3>Races</h3>
      <div className="plan-races">
        {draft.races.map((r, i) => (
          <div key={i} className="plan-race">
            <input type="date" value={r.date ?? ""} onChange={(e) => setRace(i, { date: e.target.value || null, approx: false })} aria-label="Date" />
            <input value={r.name} onChange={(e) => setRace(i, { name: e.target.value })} aria-label="Race" />
            <input value={r.target} onChange={(e) => setRace(i, { target: e.target.value })} aria-label="Target" placeholder="target, e.g. 35:30–36:00" />
            <button
              className="btn icon ghost"
              onClick={() =>
                change((p) => {
                  p.races.splice(i, 1);
                  return p;
                })
              }
              aria-label="Remove race"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="btn"
          onClick={() =>
            change((p) => {
              p.races.push({ date: today, approx: false, when: "", name: "New race", target: "", role: "" });
              return p;
            })
          }
        >
          + Race
        </button>
      </div>

      <h3>Weekly structure (days without a named session)</h3>
      <table className="table plan-structure">
        <thead>
          <tr>
            <th>Day</th>
            <th>Phases 1–2</th>
            <th>Phase 3</th>
          </tr>
        </thead>
        <tbody>
          {draft.structure.map((r, i) => (
            <tr key={r.day}>
              <td>{r.day}</td>
              <td>
                <input
                  value={r.phases12}
                  onChange={(e) =>
                    change((p) => {
                      p.structure[i] = { ...p.structure[i], phases12: e.target.value };
                      return p;
                    })
                  }
                />
              </td>
              <td>
                <input
                  value={r.phase3}
                  onChange={(e) =>
                    change((p) => {
                      p.structure[i] = { ...p.structure[i], phase3: e.target.value };
                      return p;
                    })
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dirty && (
        <div className="plan-save-float">
          <span>Unsaved changes</span>
          <button className="btn btn-primary" disabled={busy} onClick={save}>
            Save
          </button>
        </div>
      )}
    </div>
  );
}

