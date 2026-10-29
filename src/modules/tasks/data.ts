import { db } from "../../core/db";
import type { SqlParam } from "../../core/backend.types";
import { notifyChanged } from "../../core/events";
import { addDays, diffDays, todayKey } from "../../core/time";
import { parseTask, type ParsedTask } from "./parse";
import { nextOccurrence } from "./recur";

export type Status = "todo" | "doing" | "waiting" | "done";
export const STATUSES: { id: Status; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "doing", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
];

export const PROJECT_COLOURS = ["#6aa8ff", "#5ad6a8", "#f2b84b", "#c792ea", "#ff8a65", "#4dd0e1", "#f06292", "#aed581"];

export interface Task {
  id: number;
  title: string;
  notes: string | null;
  project_id: number | null;
  project_name: string | null;
  project_color: string | null;
  parent_id: number | null;
  priority: number | null;
  status: Status;
  start: string | null;
  due: string | null;
  effort: number | null;
  recur: string | null;
  done_at: string | null;
  done_day: string | null;
  created_at: string;
  sort: number;
  sub_total: number;
  sub_done: number;
}

export interface Project {
  id: number;
  name: string;
  color: string;
  sort: number;
  open: number;
  done: number;
}

export const migrations = [
  // 0 — Stage 1 (never edit)
  `CREATE TABLE tasks (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     project TEXT,
     priority INTEGER,
     due TEXT,
     done_at TEXT,
     done_day TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX tasks_open ON tasks(done_at, due);`,
  // 1 — projects, subtasks, notes, statuses, start dates, effort, repeats, sync ids
  `CREATE TABLE projects (
     id INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     color TEXT NOT NULL DEFAULT '#6aa8ff',
     sort INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT,
     remote_id TEXT
   );
   ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
   ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
   ALTER TABLE tasks ADD COLUMN notes TEXT;
   ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'todo';
   ALTER TABLE tasks ADD COLUMN start TEXT;
   ALTER TABLE tasks ADD COLUMN effort INTEGER;
   ALTER TABLE tasks ADD COLUMN recur TEXT;
   ALTER TABLE tasks ADD COLUMN sort REAL NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN updated_at TEXT;
   ALTER TABLE tasks ADD COLUMN remote_id TEXT;
   ALTER TABLE tasks ADD COLUMN deleted_at TEXT;
   INSERT OR IGNORE INTO projects (name, created_at) SELECT DISTINCT project, datetime('now') FROM tasks WHERE project IS NOT NULL;
   UPDATE projects SET sort = id, color = CASE id % 8
     WHEN 1 THEN '#6aa8ff' WHEN 2 THEN '#5ad6a8' WHEN 3 THEN '#f2b84b' WHEN 4 THEN '#c792ea'
     WHEN 5 THEN '#ff8a65' WHEN 6 THEN '#4dd0e1' WHEN 7 THEN '#f06292' ELSE '#aed581' END;
   UPDATE tasks SET project_id = (SELECT p.id FROM projects p WHERE p.name = tasks.project) WHERE project IS NOT NULL;
   UPDATE tasks SET status = 'done' WHERE done_at IS NOT NULL;
   UPDATE tasks SET updated_at = created_at, sort = id;
   CREATE INDEX tasks_parent ON tasks(parent_id);
   CREATE INDEX tasks_project ON tasks(project_id);`,
];

const TOPIC = "tasks";
const now = () => new Date().toISOString();
const changed = () => notifyChanged(TOPIC);

const SELECT_TASK = `
  SELECT t.id, t.title, t.notes, t.project_id, p.name AS project_name, p.color AS project_color,
         t.parent_id, t.priority, t.status, t.start, t.due, t.effort, t.recur,
         t.done_at, t.done_day, t.created_at, t.sort,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL) AS sub_total,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.deleted_at IS NULL AND s.done_at IS NOT NULL) AS sub_done
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`;

/** Top-level tasks that are open, or were finished today (so a mis-tap is easy to undo). */
export function loadTasks(today: string) {
  return db.select<Task>(
    `${SELECT_TASK}
     WHERE t.parent_id IS NULL AND t.deleted_at IS NULL AND (t.done_at IS NULL OR t.done_day = ?)
     ORDER BY t.sort, t.id`,
    [today],
  );
}

export async function loadTask(id: number): Promise<{ task: Task | null; subtasks: Task[] }> {
  const [task] = await db.select<Task>(`${SELECT_TASK} WHERE t.id = ?`, [id]);
  const subtasks = await db.select<Task>(`${SELECT_TASK} WHERE t.parent_id = ? AND t.deleted_at IS NULL ORDER BY t.sort, t.id`, [id]);
  return { task: task ?? null, subtasks };
}

export function loadProjects() {
  return db.select<Project>(
    `SELECT p.id, p.name, p.color, p.sort,
       (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL AND t.deleted_at IS NULL AND t.done_at IS NULL) AS open,
       (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.parent_id IS NULL AND t.deleted_at IS NULL AND t.done_at IS NOT NULL) AS done
     FROM projects p WHERE p.archived = 0 ORDER BY p.sort, p.id`,
  );
}

// ---- Projects ----------------------------------------------------------------

export async function ensureProject(name: string | null): Promise<number | null> {
  const n = name?.trim();
  if (!n) return null;
  const rows = await db.select<{ id: number; archived: number }>("SELECT id, archived FROM projects WHERE name = ? COLLATE NOCASE", [n]);
  if (rows.length) {
    if (rows[0].archived) await db.execute("UPDATE projects SET archived = 0, updated_at = ? WHERE id = ?", [now(), rows[0].id]);
    return rows[0].id;
  }
  const [{ c }] = await db.select<{ c: number }>("SELECT count(*) AS c FROM projects");
  const r = await db.execute("INSERT INTO projects (name, color, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
    n,
    PROJECT_COLOURS[c % PROJECT_COLOURS.length],
    c + 1,
    now(),
    now(),
  ]);
  return r.lastInsertId;
}

export async function createProject(name: string) {
  if (!name.trim()) throw new Error("Give the project a name.");
  await ensureProject(name);
  await changed();
}

export async function updateProject(id: number, patch: { name?: string; color?: string; archived?: boolean }) {
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Give the project a name.");
    sets.push("name = ?");
    params.push(patch.name.trim());
  }
  if (patch.color !== undefined) {
    sets.push("color = ?");
    params.push(patch.color);
  }
  if (patch.archived !== undefined) {
    sets.push("archived = ?");
    params.push(patch.archived ? 1 : 0);
  }
  if (!sets.length) return;
  try {
    await db.execute(`UPDATE projects SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [...params, now(), id]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error("There's already a project with that name.");
    throw e;
  }
  await changed();
}

// ---- Tasks -------------------------------------------------------------------

export async function addTask(t: ParsedTask, opts: { parentId?: number; status?: Status } = {}) {
  if (!t.title.trim()) throw new Error("Give the task a name.");
  const projectId = opts.parentId ? null : await ensureProject(t.project);
  const [{ next }] = await db.select<{ next: number }>(
    "SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM tasks WHERE parent_id IS ?",
    [opts.parentId ?? null],
  );
  const r = await db.execute(
    `INSERT INTO tasks (title, project_id, parent_id, priority, due, start, effort, recur, status, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.title.trim(), projectId, opts.parentId ?? null, t.priority, t.due, t.start, t.effort, t.recur, opts.status ?? "todo", next, now(), now()],
  );
  await changed();
  return r.lastInsertId;
}

export function addTaskFromText(text: string) {
  return addTask(parseTask(text, todayKey()));
}

export function addSubtask(parentId: number, title: string) {
  return addTask({ title, project: null, priority: null, due: null, start: null, effort: null, recur: null }, { parentId });
}

export interface TaskPatch {
  title?: string;
  notes?: string | null;
  project_id?: number | null;
  priority?: number | null;
  start?: string | null;
  due?: string | null;
  effort?: number | null;
  recur?: string | null;
}

export async function updateTask(id: number, patch: TaskPatch) {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  if (patch.title !== undefined && !patch.title.trim()) throw new Error("Give the task a name.");
  await db.execute(`UPDATE tasks SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, [
    ...entries.map(([, v]) => (typeof v === "string" ? v.trim() || null : (v as SqlParam))),
    now(),
    id,
  ]);
  await changed();
}

/** Updates a task from the one-line syntax, keeping notes and subtasks. */
export async function updateTaskFromText(id: number, text: string) {
  const p = parseTask(text, todayKey());
  await updateTask(id, {
    title: p.title,
    project_id: await ensureProject(p.project),
    priority: p.priority,
    due: p.due,
    start: p.start,
    effort: p.effort,
    recur: p.recur,
  });
}

/**
 * Changes status. Finishing a repeating task creates its next occurrence
 * (with fresh, unticked subtasks) and hands the repeat rule on to it.
 */
export async function setStatus(id: number, status: Status) {
  const { task, subtasks } = await loadTask(id);
  if (!task) return;
  const today = todayKey();
  if (status === "done") {
    await db.execute("UPDATE tasks SET status = 'done', done_at = ?, done_day = ?, updated_at = ? WHERE id = ?", [now(), today, now(), id]);
    if (task.recur && !task.parent_id && task.status !== "done") await spawnNext(task, subtasks, today);
  } else {
    await db.execute("UPDATE tasks SET status = ?, done_at = NULL, done_day = NULL, updated_at = ? WHERE id = ?", [status, now(), id]);
  }
  await changed();
}

async function spawnNext(task: Task, subtasks: Task[], today: string) {
  const anchor = task.due ?? today;
  // Never schedule the next one in the past, e.g. when a weekly task was finished late.
  let due = nextOccurrence(task.recur!, anchor);
  while (due < today) due = nextOccurrence(task.recur!, due);
  const shift = diffDays(anchor, due);
  const start = task.start ? addDays(task.start, shift) : null;
  const r = await db.execute(
    `INSERT INTO tasks (title, notes, project_id, priority, due, start, effort, recur, status, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?)`,
    [task.title, task.notes, task.project_id, task.priority, task.due ? due : null, start, task.effort, task.recur, task.sort + 0.5, now(), now()],
  );
  for (const s of subtasks)
    await db.execute("INSERT INTO tasks (title, parent_id, status, sort, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?)", [
      s.title,
      r.lastInsertId,
      s.sort,
      now(),
      now(),
    ]);
  // The series continues on the new task.
  await db.execute("UPDATE tasks SET recur = NULL WHERE id = ?", [task.id]);
}

export function setDone(id: number, done: boolean) {
  return setStatus(id, done ? "done" : "todo");
}

/** Soft delete, so a sync can tell Google Tasks about it. */
export async function deleteTask(id: number) {
  await db.batch([
    { sql: "UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? OR parent_id = ?", params: [now(), now(), id, id] },
  ]);
  await changed();
}

/** Moves a task before/after another (used by drag and drop and the up/down buttons). */
export async function reorder(ids: number[]) {
  await db.batch(ids.map((id, i) => ({ sql: "UPDATE tasks SET sort = ? WHERE id = ?", params: [i + 1, id] })));
  await changed();
}

// ---- Grouping for the Focus view --------------------------------------------

export type FocusGroupKey = "overdue" | "today" | "doing" | "week" | "later" | "nodate" | "waiting" | "scheduled";

export function focusGroup(t: Task, today: string): FocusGroupKey {
  if (t.status === "waiting") return "waiting";
  if (t.start && t.start > today) return "scheduled";
  if (t.due && t.due < today) return "overdue";
  if (t.due === today) return "today";
  if (t.status === "doing") return "doing";
  if (!t.due) return "nodate";
  return diffDays(today, t.due) <= 7 ? "week" : "later";
}

/** Sort inside a group: due date, then priority, then manual order. */
export function compareTasks(a: Task, b: Task) {
  return (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority ?? 9) - (b.priority ?? 9) || a.sort - b.sort;
}
