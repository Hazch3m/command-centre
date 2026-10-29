import { db } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { todayKey } from "../../core/time";
import { parseTask, type ParsedTask } from "./parse";

export interface Task {
  id: number;
  title: string;
  project: string | null;
  priority: number | null;
  due: string | null;
  done_at: string | null;
  done_day: string | null;
  created_at: string;
}

export const migrations = [
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
];

const TOPIC = "tasks";

/** Open tasks plus anything finished today (shown struck through so a mis-tap is easy to undo). */
export function loadTasks(today: string) {
  return db.select<Task>(
    `SELECT * FROM tasks
     WHERE done_at IS NULL OR done_day = ?
     ORDER BY done_at IS NOT NULL, due IS NULL, due, COALESCE(priority, 9), created_at`,
    [today],
  );
}

export async function addTask(t: ParsedTask) {
  if (!t.title.trim()) throw new Error("Give the task a name.");
  await db.execute("INSERT INTO tasks (title, project, priority, due, created_at) VALUES (?, ?, ?, ?, ?)", [
    t.title.trim(),
    t.project,
    t.priority,
    t.due,
    new Date().toISOString(),
  ]);
  await notifyChanged(TOPIC);
}

export function addTaskFromText(text: string) {
  return addTask(parseTask(text, todayKey()));
}

export async function setDone(id: number, done: boolean) {
  if (done) await db.execute("UPDATE tasks SET done_at = ?, done_day = ? WHERE id = ?", [new Date().toISOString(), todayKey(), id]);
  else await db.execute("UPDATE tasks SET done_at = NULL, done_day = NULL WHERE id = ?", [id]);
  await notifyChanged(TOPIC);
}

export async function updateTask(id: number, t: ParsedTask) {
  if (!t.title.trim()) throw new Error("Give the task a name.");
  await db.execute("UPDATE tasks SET title = ?, project = ?, priority = ?, due = ? WHERE id = ?", [
    t.title.trim(),
    t.project,
    t.priority,
    t.due,
    id,
  ]);
  await notifyChanged(TOPIC);
}

export async function deleteTask(id: number) {
  await db.execute("DELETE FROM tasks WHERE id = ?", [id]);
  await notifyChanged(TOPIC);
}

export async function listProjects(): Promise<string[]> {
  const rows = await db.select<{ project: string }>(
    "SELECT project FROM tasks WHERE project IS NOT NULL GROUP BY project ORDER BY MAX(created_at) DESC LIMIT 30",
  );
  return rows.map((r) => r.project);
}
