import type { DragEvent } from "react";
import { diffDays, relativeDayLabel } from "../../core/time";
import { TickButton } from "../../shell/ui";
import { setDone, type Task } from "./data";
import { formatEffort } from "./parse";
import { describeRecur } from "./recur";

export const PRIORITY_NAME: Record<number, string> = { 1: "High", 2: "Medium", 3: "Low" };

export function dueLabel(due: string, today: string): { text: string; overdue: boolean } {
  const d = diffDays(today, due);
  if (d < 0) return { text: d === -1 ? "Due yesterday" : `${-d} days overdue`, overdue: true };
  return { text: d <= 1 ? `Due ${relativeDayLabel(due, today).toLowerCase()}` : `Due ${relativeDayLabel(due, today)}`, overdue: false };
}

export function ProjectChip({ name, color }: { name: string; color: string | null }) {
  return (
    <span className="chip project-chip">
      <span className="dot" style={{ background: color ?? "var(--muted)" }} />
      {name}
    </span>
  );
}

interface Props {
  task: Task;
  today: string;
  onOpen: (id: number) => void;
  showProject?: boolean;
  compact?: boolean;
  draggable?: boolean;
}

export function TaskRow({ task, today, onOpen, showProject = true, compact = false, draggable = false }: Props) {
  const done = task.status === "done";
  const due = task.due ? dueLabel(task.due, today) : null;
  const overdue = !!due?.overdue && !done;
  const scheduled = task.start && task.start > today;

  const onDragStart = (e: DragEvent) => {
    e.dataTransfer.setData("text/task-id", String(task.id));
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <li
      className={`task-row prio-${task.priority ?? 0}` + (done ? " is-done" : "") + (overdue ? " is-overdue" : "") + (compact ? " compact" : "")}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
    >
      <TickButton done={done} onClick={() => setDone(task.id, !done)} label={done ? "Mark as not done" : "Mark as done"} />
      <button className="task-main" onClick={() => onOpen(task.id)} title="Open task">
        <span className="task-title">{task.title}</span>
        <span className="task-meta">
          {task.status === "doing" && !compact && <span className="status-pill doing">In progress</span>}
          {task.status === "waiting" && !compact && <span className="status-pill waiting">Waiting</span>}
          {due && <span className={"task-due" + (overdue ? " danger" : "")}>{due.text}</span>}
          {scheduled && <span>From {relativeDayLabel(task.start!, today)}</span>}
          {showProject && task.project_name && <ProjectChip name={task.project_name} color={task.project_color} />}
          {task.priority && !compact && <span className={`prio-label prio-label-${task.priority}`}>{PRIORITY_NAME[task.priority]}</span>}
          {task.sub_total > 0 && (
            <span className="sub-progress" title={`${task.sub_done} of ${task.sub_total} subtasks done`}>
              <span className="sub-bar">
                <span style={{ width: `${(task.sub_done / task.sub_total) * 100}%` }} />
              </span>
              {task.sub_done}/{task.sub_total}
            </span>
          )}
          {task.effort && <span title="Estimate">⏱ {formatEffort(task.effort)}</span>}
          {task.recur && <span title={describeRecur(task.recur)}>↻ {compact ? "" : describeRecur(task.recur)}</span>}
          {task.notes && <span title="Has notes">≡</span>}
        </span>
      </button>
    </li>
  );
}
