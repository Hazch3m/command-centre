import { useMemo, useState, type KeyboardEvent } from "react";
import { useDataVersion } from "../../core/events";
import { diffDays, relativeDayLabel, todayKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, Empty, ErrorNote, TickButton } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { addTask, addTaskFromText, deleteTask, loadTasks, migrations, setDone, updateTask, type Task } from "./data";
import { parseTask, type ParsedTask } from "./parse";

const PRIORITY_NAME = { 1: "High", 2: "Medium", 3: "Low" } as Record<number, string>;
export const SYNTAX_HINT = "#project   !1 !2 !3   @today @fri @3/11 @+5";

function toText(t: Task): string {
  return [
    t.title,
    t.project ? "#" + t.project.replace(/ /g, "-") : "",
    t.priority ? "!" + t.priority : "",
    t.due ? "@" + t.due : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function describeParsed(p: ParsedTask, today: string): string | null {
  const bits = [
    p.project && `#${p.project}`,
    p.priority && `${PRIORITY_NAME[p.priority]} priority`,
    p.due && `due ${relativeDayLabel(p.due, today)}`,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

type Group = { key: string; label: string; tone?: "danger" | "accent"; tasks: Task[] };

function groupTasks(tasks: Task[], today: string): { groups: Group[]; done: Task[] } {
  const g: Record<string, Group> = {
    overdue: { key: "overdue", label: "Overdue", tone: "danger", tasks: [] },
    today: { key: "today", label: "Today", tone: "accent", tasks: [] },
    week: { key: "week", label: "Next 7 days", tasks: [] },
    later: { key: "later", label: "Later", tasks: [] },
    none: { key: "none", label: "No date", tasks: [] },
  };
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.done_at) done.push(t);
    else if (!t.due) g.none.tasks.push(t);
    else {
      const d = diffDays(today, t.due);
      (d < 0 ? g.overdue : d === 0 ? g.today : d <= 7 ? g.week : g.later).tasks.push(t);
    }
  }
  return { groups: Object.values(g).filter((x) => x.tasks.length), done };
}

function dueLabel(due: string, today: string): { text: string; overdue: boolean } {
  const d = diffDays(today, due);
  if (d < 0) return { text: d === -1 ? "Yesterday" : `${-d} days overdue`, overdue: true };
  return { text: relativeDayLabel(due, today), overdue: false };
}

function TaskRow({ task, today, editing }: { task: Task; today: string; editing: boolean }) {
  const [edit, setEdit] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = !!task.done_at;
  const due = task.due ? dueLabel(task.due, today) : null;

  const save = async () => {
    if (edit == null) return;
    try {
      await updateTask(task.id, parseTask(edit, todayKey()));
      setEdit(null);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") setEdit(null);
  };

  if (edit != null) {
    const preview = describeParsed(parseTask(edit, today), today);
    return (
      <li className="task-row task-editing">
        <div className="task-edit">
          <input autoFocus value={edit} onChange={(e) => setEdit(e.target.value)} onKeyDown={onKey} aria-label="Edit task" />
          <div className="task-edit-meta">
            <span className="muted">{preview ?? SYNTAX_HINT}</span>
            <span className="task-edit-actions">
              <button className="btn btn-danger" onClick={() => deleteTask(task.id)}>Delete</button>
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={save}>Save</button>
            </span>
          </div>
          <ErrorNote error={err} />
        </div>
      </li>
    );
  }

  return (
    <li className={`task-row prio-${task.priority ?? 0}` + (done ? " is-done" : "") + (due?.overdue && !done ? " is-overdue" : "")}>
      <TickButton done={done} onClick={() => setDone(task.id, !done)} label={done ? "Mark as not done" : "Mark as done"} />
      <button className="task-main" onClick={() => !editing && setEdit(toText(task))} title="Click to edit">
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {due && <span className={"task-due" + (due.overdue ? " danger" : "")}>{due.text}</span>}
          {task.project && <span className="chip">{task.project}</span>}
          {task.priority && <span className={`prio-label prio-label-${task.priority}`}>{PRIORITY_NAME[task.priority]}</span>}
        </span>
      </button>
    </li>
  );
}

function TasksCard({ editing }: CardProps) {
  const today = useToday();
  const version = useDataVersion("tasks");
  const { data: tasks, error } = useQuery(() => loadTasks(today), [today, version]);
  const [draft, setDraft] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const { groups, done } = useMemo(() => groupTasks(tasks ?? [], today), [tasks, today]);
  const overdue = groups.find((g) => g.key === "overdue")?.tasks.length ?? 0;
  const dueToday = groups.find((g) => g.key === "today")?.tasks.length ?? 0;
  const parsed = parseTask(draft, today);
  const preview = draft.trim() ? describeParsed(parsed, today) : null;

  const submit = async () => {
    if (!draft.trim()) return;
    try {
      await addTask(parsed);
      setDraft("");
      setAddErr(null);
    } catch (e) {
      setAddErr((e as Error).message);
    }
  };

  return (
    <>
      <CardHeader
        title="Tasks"
        right={
          <>
            {overdue > 0 && <span className="pill pill-danger">{overdue} overdue</span>}
            <span className="pill">{dueToday} today</span>
          </>
        }
      />
      <div className="task-add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Add a task…"
          aria-label="New task"
          disabled={editing}
        />
        <div className="task-add-hint muted">{preview ?? (draft ? " " : SYNTAX_HINT)}</div>
        <ErrorNote error={addErr} />
      </div>
      <ErrorNote error={error} />
      <div className="card-scroll">
        {tasks && groups.length === 0 && done.length === 0 && <Empty>Nothing outstanding. Add a task above or press the quick-add shortcut from anywhere.</Empty>}
        {groups.map((g) => (
          <section key={g.key} className="task-group">
            <h3 className={g.tone ? `tone-${g.tone}` : undefined}>
              {g.label} <span className="count">{g.tasks.length}</span>
            </h3>
            <ul>
              {g.tasks.map((t) => (
                <TaskRow key={t.id} task={t} today={today} editing={editing} />
              ))}
            </ul>
          </section>
        ))}
        {done.length > 0 && (
          <section className="task-group">
            <h3>
              <button className="link" onClick={() => setShowDone((s) => !s)}>
                Done today <span className="count">{done.length}</span> {showDone ? "▾" : "▸"}
              </button>
            </h3>
            {showDone && (
              <ul>
                {done.map((t) => (
                  <TaskRow key={t.id} task={t} today={today} editing={editing} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </>
  );
}

export const tasksModule: DashboardModule = {
  id: "tasks",
  title: "Tasks",
  defaultPos: { x: 0, y: 4, w: 7, h: 13 },
  minW: 4,
  minH: 5,
  migrations,
  Card: TasksCard,
  quickAdd: [
    {
      id: "task",
      label: "Task",
      placeholder: "What needs doing?",
      hint: SYNTAX_HINT,
      preview: (text) => {
        const today = todayKey();
        return describeParsed(parseTask(text, today), today);
      },
      add: addTaskFromText,
    },
  ],
};
