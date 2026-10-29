import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDataVersion } from "../../core/events";
import { useQuery } from "../../core/useQuery";
import { ErrorNote, TickButton } from "../../shell/ui";
import {
  addSubtask,
  deleteTask,
  ensureProject,
  loadProjects,
  loadTask,
  reorder,
  setDone,
  setStatus,
  STATUSES,
  updateTask,
  type Task,
  type TaskPatch,
} from "./data";
import { formatEffort, parseEffort } from "./parse";
import { describeRecur } from "./recur";

const PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Doesn't repeat" },
  { value: "d:1", label: "Daily" },
  { value: "wd", label: "Weekdays" },
  { value: "w:1:", label: "Weekly" },
  { value: "w:2:", label: "Fortnightly" },
  { value: "m:1", label: "Monthly" },
  { value: "custom", label: "Weekly on chosen days…" },
];
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function Subtasks({ parent, subtasks }: { parent: Task; subtasks: Task[] }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const guard = (p: Promise<unknown>) => p.then(() => setErr(null), (e) => setErr((e as Error).message));
  const move = (i: number, d: -1 | 1) => {
    const ids = subtasks.map((s) => s.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    guard(reorder(ids));
  };
  const done = subtasks.filter((s) => s.status === "done").length;
  return (
    <section className="detail-section">
      <h4>
        Subtasks {subtasks.length > 0 && <span className="muted">{done}/{subtasks.length}</span>}
      </h4>
      {subtasks.length > 0 && (
        <div className="sub-bar wide">
          <span style={{ width: `${(done / subtasks.length) * 100}%` }} />
        </div>
      )}
      <ul className="subtask-list">
        {subtasks.map((s, i) => (
          <li key={s.id} className={"subtask" + (s.status === "done" ? " is-done" : "")}>
            <TickButton done={s.status === "done"} onClick={() => guard(setDone(s.id, s.status !== "done"))} label={`Tick ${s.title}`} />
            <input
              defaultValue={s.title}
              aria-label="Subtask"
              onBlur={(e) => e.target.value.trim() !== s.title && guard(updateTask(s.id, { title: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            />
            <button className="btn icon ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button className="btn icon ghost" onClick={() => move(i, 1)} disabled={i === subtasks.length - 1} aria-label="Move down">↓</button>
            <button className="btn icon ghost" onClick={() => guard(deleteTask(s.id))} aria-label={`Delete ${s.title}`}>✕</button>
          </li>
        ))}
      </ul>
      <div className="inline">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a step…"
          aria-label="New subtask"
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && guard(addSubtask(parent.id, draft).then(() => setDraft("")))}
        />
        <button className="btn" disabled={!draft.trim()} onClick={() => guard(addSubtask(parent.id, draft).then(() => setDraft("")))}>
          Add
        </button>
      </div>
      <ErrorNote error={err} />
    </section>
  );
}

function RepeatPicker({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const isCustom = !!value && value.startsWith("w:") && value.split(":")[2] !== "";
  const [custom, setCustom] = useState(isCustom);
  const days = isCustom ? value!.split(":")[2].split(",").map(Number) : [];
  const preset = custom || isCustom ? "custom" : value ?? "";
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    onChange(next.length ? `w:1:${next.sort().join(",")}` : "w:1:");
  };
  return (
    <div className="repeat">
      <select
        value={PRESETS.some((p) => p.value === preset) ? preset : ""}
        onChange={(e) => {
          const v = e.target.value;
          setCustom(v === "custom");
          onChange(v === "custom" ? "w:1:" : v || null);
        }}
        aria-label="Repeat"
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <span className="day-toggles">
          {WEEKDAYS.map((d) => (
            <button key={d} className={"day" + (days.includes(d) ? " on" : "")} onClick={() => toggleDay(d)}>
              {DAY_SHORT[d]}
            </button>
          ))}
        </span>
      )}
      {value && <span className="muted small">{describeRecur(value)} · the next one is created when you finish this one</span>}
    </div>
  );
}

export function TaskDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const version = useDataVersion("tasks");
  const { data, error } = useQuery(() => Promise.all([loadTask(id), loadProjects()]), [id, version]);
  const [err, setErr] = useState<string | null>(null);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const task = data?.[0].task;
  const subtasks = data?.[0].subtasks ?? [];
  const projects = data?.[1] ?? [];
  const guard = (p: Promise<unknown>) => p.then(() => setErr(null), (e) => setErr((e as Error).message));
  const patch = (p: TaskPatch) => guard(updateTask(id, p));

  // Deleted elsewhere (or by the delete button): close.
  useEffect(() => {
    if (data && !data[0].task) onClose();
  }, [data, onClose]);
  if (data && !task) return null;

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal task-detail" role="dialog" aria-label="Task">
        {!task ? (
          <ErrorNote error={error} />
        ) : (
          <>
            <header className="detail-head">
              <TickButton done={task.status === "done"} onClick={() => guard(setDone(task.id, task.status !== "done"))} label="Done" />
              <input
                key={`t${task.id}`}
                className="detail-title"
                defaultValue={task.title}
                aria-label="Title"
                onBlur={(e) => e.target.value.trim() !== task.title && patch({ title: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
              />
              <button className="btn icon ghost" onClick={onClose} aria-label="Close">✕</button>
            </header>

            <div className="detail-grid">
              <label>Status</label>
              <div className="segmented">
                {STATUSES.map((s) => (
                  <button key={s.id} className={task.status === s.id ? "on" : ""} onClick={() => guard(setStatus(task.id, s.id))}>
                    {s.label}
                  </button>
                ))}
              </div>

              <label>Priority</label>
              <div className="segmented">
                {[null, 1, 2, 3].map((p) => (
                  <button key={String(p)} className={(task.priority ?? null) === p ? `on prio-on-${p ?? 0}` : ""} onClick={() => patch({ priority: p })}>
                    {p === null ? "None" : p === 1 ? "High" : p === 2 ? "Medium" : "Low"}
                  </button>
                ))}
              </div>

              <label>Project</label>
              <div className="inline">
                {newProject === null ? (
                  <select
                    value={task.project_id ?? ""}
                    aria-label="Project"
                    onChange={(e) => {
                      if (e.target.value === "__new") setNewProject("");
                      else patch({ project_id: e.target.value ? Number(e.target.value) : null });
                    }}
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value="__new">New project…</option>
                  </select>
                ) : (
                  <>
                    <input autoFocus value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="Project name" aria-label="New project name"
                      onKeyDown={async (e) => {
                        if (e.key === "Enter" && newProject.trim()) {
                          await guard(ensureProject(newProject).then((pid) => updateTask(task.id, { project_id: pid })));
                          setNewProject(null);
                        }
                        if (e.key === "Escape") { e.stopPropagation(); setNewProject(null); }
                      }} />
                    <button className="btn" onClick={() => setNewProject(null)}>Cancel</button>
                  </>
                )}
              </div>

              <label>Start</label>
              <div className="inline">
                <input type="date" value={task.start ?? ""} onChange={(e) => patch({ start: e.target.value || null })} aria-label="Start date" />
                <span className="muted small">Hidden from Focus until then</span>
              </div>

              <label>Due</label>
              <input type="date" value={task.due ?? ""} onChange={(e) => patch({ due: e.target.value || null })} aria-label="Due date" />

              <label>Estimate</label>
              <input
                key={`e${task.id}-${task.effort}`}
                defaultValue={formatEffort(task.effort)}
                placeholder="e.g. 45m or 2h"
                aria-label="Estimate"
                style={{ width: "8em" }}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (!v) patch({ effort: null });
                  else {
                    const m = parseEffort(v);
                    if (m) patch({ effort: m });
                    else setErr("Write the estimate like 45m, 2h or 1h30.");
                  }
                }}
              />

              <label>Repeat</label>
              <RepeatPicker value={task.recur} onChange={(v) => patch({ recur: v })} />
            </div>

            <section className="detail-section">
              <h4>Notes</h4>
              <textarea
                key={`n${task.id}`}
                defaultValue={task.notes ?? ""}
                placeholder="Details, links, context…"
                aria-label="Notes"
                rows={4}
                onBlur={(e) => (e.target.value || null) !== task.notes && patch({ notes: e.target.value })}
              />
            </section>

            {!task.parent_id && <Subtasks parent={task} subtasks={subtasks} />}

            <ErrorNote error={err} />
            <footer className="detail-foot">
              <span className="muted small">Added {new Date(task.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
              {confirmDelete ? (
                <span className="inline">
                  <span className="small">Delete this task{subtasks.length ? " and its subtasks" : ""}?</span>
                  <button className="btn" onClick={() => setConfirmDelete(false)}>Keep</button>
                  <button className="btn btn-danger-solid" onClick={() => guard(deleteTask(task.id)).then(onClose)}>Delete</button>
                </span>
              ) : (
                <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete task</button>
              )}
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
