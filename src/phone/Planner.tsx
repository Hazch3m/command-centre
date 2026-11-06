import { useState } from "react";
import { Calendar } from "./Calendar";
import { Habits } from "./Habits";
import { Tasks } from "./Tasks";

export type PlannerView = "calendar" | "tasks" | "habits";
const VIEWS: { id: PlannerView; label: string }[] = [
  { id: "calendar", label: "Calendar" },
  { id: "tasks", label: "Tasks" },
  { id: "habits", label: "Habits" },
];
const KEY = "cc-planner-view";

const saved = (): PlannerView => {
  try {
    const v = sessionStorage.getItem(KEY) as PlannerView | null;
    return v && VIEWS.some((x) => x.id === v) ? v : "calendar";
  } catch {
    return "calendar";
  }
};
/** Opens the Planner tab on a view (from Today's "All tasks", a card, …). */
export function plannerView(v: PlannerView) {
  try {
    sessionStorage.setItem(KEY, v);
  } catch {
    /* fine */
  }
}

/** Planner: your calendar, tasks and habits, like the desktop dashboard's. */
export function Planner() {
  const [view, setView] = useState<PlannerView>(saved);
  const pick = (v: PlannerView) => {
    plannerView(v);
    setView(v);
    window.scrollTo({ top: 0 });
  };
  return (
    <>
      <div className="p-planner-seg">
        <div className="p-seg" role="tablist">
          {VIEWS.map((v) => (
            <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => pick(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div key={view}>{view === "calendar" ? <Calendar /> : view === "tasks" ? <Tasks /> : <Habits />}</div>
    </>
  );
}
