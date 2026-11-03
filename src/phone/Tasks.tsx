import { useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { parseTask } from "../modules/tasks/parse";
import { addTask, compareTasks, ensureProject, deleteTask, focusGroup, loadProjects, loadTasks, setDone, updateTask, type FocusGroupKey, type Task } from "../modules/tasks/data";
import { dayName, Section, Sheet } from "./common";

const GROUPS: { key: FocusGroupKey | "done"; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "doing", label: "In progress" },
  { key: "week", label: "Next 7 days" },
  { key: "later", label: "Later" },
  { key: "nodate", label: "No date" },
  { key: "waiting", label: "Waiting" },
  { key: "scheduled", label: "Scheduled" },
  { key: "done", label: "Done today" },
];
const PRIO = ["", "High", "Medium", "Low"];

function DueChips({ value, onChange, today }: { value: string | null; onChange: (d: string | null) => void; today: string }) {
  const opts: [string, string | null][] = [
    ["Today", today],
    ["Tomorrow", addDays(today, 1)],
    ["Next week", addDays(today, 7 - ((new Date(today + "T12:00").getDay() + 6) % 7))],
    ["No date", null],
  ];
  return (
    <div className="p-chips">
      {opts.map(([l, d]) => (
        <button type="button" key={l} className={"p-chip-btn" + (value === d ? " on" : "")} onClick={() => onChange(d)}>
          {l}
        </button>
      ))}
      <input type="date" className="p-date" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-label="Due date" />
    </div>
  );
}

/** Add or change a task. */
function TaskSheet({ task, onClose, today }: { task: Task | null; onClose: () => void; today: string }) {
  const projects = useQuery(loadProjects, []).data ?? [];
  const [title, setTitle] = useState(task?.title ?? "");
  const [due, setDue] = useState<string | null>(task ? task.due : today);
  const [priority, setPriority] = useState<number | null>(task?.priority ?? null);
  const [project, setProject] = useState<string>(task?.project_name ?? "");
  const [notes, setNotes] = useState(task?.notes ?? "");
  const [armed, setArmed] = useState(false);
  const save = async () => {
    if (!title.trim()) return;
    if (task) await updateTask(task.id, { title: title.trim(), due, priority, project_id: await ensureProject(project || null), notes: notes || null });
    else {
      const p = parseTask(title, today);
      await addTask({ ...p, due: p.due ?? due, priority: p.priority ?? priority, project: p.project ?? (project || null) });
    }
    onClose();
  };
  return (
    <Sheet title={task ? "Task" : "New task"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <input className="p-input" autoFocus={!task} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" enterKeyHint="done" />
        <div className="p-field-label">Due</div>
        <DueChips value={due} onChange={setDue} today={today} />
        <div className="p-field-label">Priority</div>
        <div className="p-chips">
          {[null, 1, 2, 3].map((p) => (
            <button type="button" key={String(p)} className={"p-chip-btn" + (priority === p ? " on" : "")} onClick={() => setPriority(p)}>
              {p ? PRIO[p] : "None"}
            </button>
          ))}
        </div>
        <div className="p-field-label">Project</div>
        <select className="p-input" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">None</option>
          {projects.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        {task && (
          <>
            <div className="p-field-label">Notes</div>
            <textarea className="p-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </>
        )}
        <button className="p-primary" disabled={!title.trim()}>
          {task ? "Save" : "Add task"}
        </button>
        {task && (
          <button
            type="button"
            className="p-link danger"
            onClick={() => {
              if (!armed) return setArmed(true);
              deleteTask(task.id).then(onClose);
            }}
          >
            {armed ? "Tap again to delete" : "Delete task"}
          </button>
        )}
      </form>
    </Sheet>
  );
}

export function Tasks() {
  const today = useToday();
  const v = useDataVersion("tasks");
  const tasks = useQuery(() => loadTasks(today), [v, today]).data ?? [];
  const [open, setOpen] = useState<Task | "new" | null>(null);
  const groups = GROUPS.map((g) => ({
    ...g,
    items: tasks.filter((t) => (g.key === "done" ? t.done_at && t.done_day === today : !t.done_at && focusGroup(t, today) === g.key)).sort(compareTasks),
  })).filter((g) => g.items.length);
  return (
    <div className="p-screen">
      {groups.map((g) => (
        <Section key={g.key} title={g.label} className={g.key === "overdue" ? "p-overdue" : ""}>
          {g.items.map((t) => (
            <div key={t.id} className={"p-row p-task" + (t.done_at ? " done" : "")}>
              <input type="checkbox" className="p-check" checked={!!t.done_at} onChange={(e) => setDone(t.id, e.target.checked)} aria-label={`Done: ${t.title}`} />
              <button className="p-row-main p-row-btn" onClick={() => setOpen(t)}>
                <span className="p-row-title">
                  {t.priority === 1 && <span className="p-prio">!</span>}
                  {t.title}
                </span>
                <span className="p-row-sub">
                  {t.project_name && (
                    <span className="p-proj">
                      <i style={{ background: t.project_color ?? "var(--muted)" }} />
                      {t.project_name}
                    </span>
                  )}
                  {t.due && g.key !== "today" && <span>{dayName(t.due, today)}</span>}
                  {t.sub_total > 0 && (
                    <span>
                      {t.sub_done}/{t.sub_total} steps
                    </span>
                  )}
                  {t.recur && <span>↻</span>}
                </span>
              </button>
            </div>
          ))}
        </Section>
      ))}
      {!groups.length && <div className="p-empty-big">Nothing to do. Tap + to add a task.</div>}
      <button className="p-fab" onClick={() => setOpen("new")} aria-label="Add a task">
        +
      </button>
      {open && <TaskSheet task={open === "new" ? null : open} onClose={() => setOpen(null)} today={today} />}
    </div>
  );
}
