/**
 * Two-way sync between local tasks and Google Tasks.
 *
 *   project      ↔ task list (tasks with no project live in Google's default list)
 *   task         ↔ task: title, notes, due date, done
 *   subtask      ↔ child task
 *
 * Priority, status (in progress / waiting), start date, estimate and repeat
 * rules stay local. Each sync pushes local changes first, then pulls remote
 * changes; when both sides changed the same task, the newer edit wins.
 */
import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import type { SqlParam } from "../../core/backend.types";
import { notifyChanged } from "../../core/events";
import { setStatus } from "./data";

const API = "https://tasks.googleapis.com/tasks/v1";

export const syncMigrations = [
  `ALTER TABLE tasks ADD COLUMN synced_at TEXT;
   ALTER TABLE tasks ADD COLUMN remote_list TEXT;
   ALTER TABLE projects ADD COLUMN synced_at TEXT;
   CREATE INDEX tasks_remote ON tasks(remote_id);`,
];

export interface TaskSync {
  lastSync: string | null;
  lastPull: string | null;
  offline: boolean;
  error: string | null;
  enabled: boolean;
}

export const getTaskSync = () => kvGet<TaskSync>("gtasks.sync", { lastSync: null, lastPull: null, offline: false, error: null, enabled: true });

interface GList {
  id: string;
  title: string;
  updated: string;
}
interface GTask {
  id: string;
  title?: string;
  notes?: string;
  due?: string;
  status: "needsAction" | "completed";
  completed?: string;
  parent?: string;
  deleted?: boolean;
  hidden?: boolean;
  updated: string;
}

interface LocalTask {
  id: number;
  title: string;
  notes: string | null;
  due: string | null;
  status: string;
  parent_id: number | null;
  project_id: number | null;
  remote_id: string | null;
  remote_list: string | null;
  updated_at: string | null;
  synced_at: string | null;
  deleted_at: string | null;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await backend.apiRequest<T>("google", method, url, body);
  if (r.status >= 400) throw new HttpError(r.status, `Google Tasks answered ${r.status} to ${method} ${url.replace(API, "")}`);
  return r.body;
}

async function all<T>(url: string): Promise<T[]> {
  const items: T[] = [];
  let token: string | undefined;
  do {
    const sep = url.includes("?") ? "&" : "?";
    const page = await call<{ items?: T[]; nextPageToken?: string }>("GET", `${url}${sep}maxResults=100${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    items.push(...(page.items ?? []));
    token = page.nextPageToken;
  } while (token);
  return items;
}

const now = () => new Date().toISOString();
const t = (s: string | null | undefined) => (s ? Date.parse(s) : 0);

function body(task: LocalTask) {
  return {
    title: task.title,
    notes: task.notes ?? "",
    due: task.due ? `${task.due}T00:00:00.000Z` : null,
    status: task.status === "done" ? "completed" : "needsAction",
  };
}

let running: Promise<TaskSync> | null = null;

/** Runs one sync; concurrent callers share the same run. */
export function syncGoogleTasks(): Promise<TaskSync> {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<TaskSync> {
  const prev = await getTaskSync();
  const status = await backend.oauthStatus("google").catch(() => null);
  if (!status?.connected || !prev.enabled) return prev;
  const startedAt = now();
  let changed = false;
  let state: TaskSync;
  try {
    // ---- 1. Lists ↔ projects ------------------------------------------------
    const lists = await all<GList>(`${API}/users/@me/lists`);
    if (!lists.length) throw new Error("Google Tasks has no lists");
    const defaultList = lists[0].id;
    const byId = new Map(lists.map((l) => [l.id, l]));
    const projects = await db.select<{ id: number; name: string; remote_id: string | null; archived: number; updated_at: string | null; synced_at: string | null }>(
      "SELECT id, name, remote_id, archived, updated_at, synced_at FROM projects",
    );
    for (const p of projects) {
      if (p.remote_id && !byId.has(p.remote_id)) {
        // List deleted on the phone: unlink rather than delete anything here.
        await db.execute("UPDATE projects SET remote_id = NULL, synced_at = NULL WHERE id = ?", [p.id]);
        await db.execute("UPDATE tasks SET remote_id = NULL, remote_list = NULL, synced_at = NULL WHERE project_id = ?", [p.id]);
        p.remote_id = null;
      }
    }
    const linked = new Set(projects.map((p) => p.remote_id).filter(Boolean));
    for (const l of lists) {
      if (l.id === defaultList || linked.has(l.id)) continue;
      const match = projects.find((p) => !p.remote_id && p.name.toLowerCase() === l.title.toLowerCase());
      if (match) {
        await db.execute("UPDATE projects SET remote_id = ?, synced_at = ? WHERE id = ?", [l.id, now(), match.id]);
        match.remote_id = l.id;
      } else {
        const [{ c }] = await db.select<{ c: number }>("SELECT count(*) AS c FROM projects");
        const r = await db.execute("INSERT INTO projects (name, sort, created_at, updated_at, synced_at, remote_id) VALUES (?, ?, ?, ?, ?, ?)", [
          l.title,
          c + 1,
          now(),
          now(),
          now(),
          l.id,
        ]);
        projects.push({ id: r.lastInsertId, name: l.title, remote_id: l.id, archived: 0, updated_at: now(), synced_at: now() });
        changed = true;
      }
    }
    for (const p of projects) {
      if (!p.remote_id && !p.archived) {
        const l = await call<GList>("POST", `${API}/users/@me/lists`, { title: p.name });
        await db.execute("UPDATE projects SET remote_id = ?, synced_at = ? WHERE id = ?", [l.id, now(), p.id]);
        p.remote_id = l.id;
      } else if (p.remote_id && t(p.updated_at) > t(p.synced_at)) {
        await call("PATCH", `${API}/users/@me/lists/${p.remote_id}`, { title: p.name });
        await db.execute("UPDATE projects SET synced_at = ? WHERE id = ?", [now(), p.id]);
      } else if (p.remote_id && byId.get(p.remote_id)!.title !== p.name) {
        await db.execute("UPDATE projects SET name = ?, synced_at = ? WHERE id = ?", [byId.get(p.remote_id)!.title, now(), p.id]).catch(() => {});
        changed = true;
      }
    }
    const listOfProject = new Map(projects.map((p) => [p.id, p.remote_id ?? defaultList]));
    const projectOfList = new Map(projects.filter((p) => p.remote_id).map((p) => [p.remote_id!, p.id]));

    // ---- 2. Push local changes ---------------------------------------------
    const deleted = await db.select<LocalTask>("SELECT * FROM tasks WHERE deleted_at IS NOT NULL AND remote_id IS NOT NULL ORDER BY parent_id IS NULL");
    for (const d of deleted) {
      try {
        await call("DELETE", `${API}/lists/${d.remote_list ?? defaultList}/tasks/${d.remote_id}`);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
      }
      await db.execute("UPDATE tasks SET remote_id = NULL WHERE id = ?", [d.id]);
    }
    await db.execute("DELETE FROM tasks WHERE deleted_at IS NOT NULL AND remote_id IS NULL");

    const dirty = await db.select<LocalTask>(
      `SELECT * FROM tasks WHERE deleted_at IS NULL AND (remote_id IS NULL OR synced_at IS NULL OR updated_at > synced_at)
       ORDER BY parent_id IS NOT NULL, id`,
    );
    for (const task of dirty) {
      let list: string;
      let parentRemote: string | null = null;
      if (task.parent_id) {
        const [p] = await db.select<{ remote_id: string | null; remote_list: string | null }>("SELECT remote_id, remote_list FROM tasks WHERE id = ?", [task.parent_id]);
        if (!p?.remote_id) continue; // parent not synced yet; next round
        list = p.remote_list!;
        parentRemote = p.remote_id;
      } else {
        list = task.project_id ? listOfProject.get(task.project_id) ?? defaultList : defaultList;
      }
      // Moved to another project: Google can't move between lists, so re-create it there.
      if (task.remote_id && task.remote_list && task.remote_list !== list) {
        await call("DELETE", `${API}/lists/${task.remote_list}/tasks/${task.remote_id}`).catch(() => {});
        await db.execute("UPDATE tasks SET remote_id = NULL, remote_list = NULL, synced_at = NULL WHERE parent_id = ?", [task.id]);
        task.remote_id = null;
      }
      let remote: GTask;
      if (task.remote_id) {
        try {
          remote = await call<GTask>("PATCH", `${API}/lists/${list}/tasks/${task.remote_id}`, body(task));
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 404)) throw e;
          remote = await call<GTask>("POST", `${API}/lists/${list}/tasks${parentRemote ? `?parent=${parentRemote}` : ""}`, body(task));
        }
      } else {
        remote = await call<GTask>("POST", `${API}/lists/${list}/tasks${parentRemote ? `?parent=${parentRemote}` : ""}`, body(task));
      }
      const stamp = now();
      await db.execute("UPDATE tasks SET remote_id = ?, remote_list = ?, synced_at = ? WHERE id = ?", [remote.id, list, stamp, task.id]);
    }

    // ---- 3. Pull remote changes ---------------------------------------------
    const since = prev.lastPull ? new Date(t(prev.lastPull) - 5 * 60_000).toISOString() : null;
    for (const listId of [defaultList, ...projectOfList.keys()]) {
      const q = `showCompleted=true&showHidden=true&showDeleted=true${since ? `&updatedMin=${encodeURIComponent(since)}` : ""}`;
      const remote = await all<GTask>(`${API}/lists/${listId}/tasks?${q}`);
      // Parents before children so subtasks can find their parent.
      remote.sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
      for (const r of remote) {
        const [local] = await db.select<LocalTask>("SELECT * FROM tasks WHERE remote_id = ?", [r.id]);
        if (r.deleted) {
          if (local && !local.deleted_at && !(t(local.updated_at) > t(local.synced_at))) {
            await db.execute("DELETE FROM tasks WHERE id = ? OR parent_id = ?", [local.id, local.id]);
            changed = true;
          }
          continue;
        }
        const due = r.due ? r.due.slice(0, 10) : null;
        const done = r.status === "completed";
        if (!local) {
          if (!r.title?.trim()) continue;
          let parentId: number | null = null;
          if (r.parent) {
            const [p] = await db.select<{ id: number }>("SELECT id FROM tasks WHERE remote_id = ?", [r.parent]);
            parentId = p?.id ?? null;
          }
          const stamp = now();
          await db.execute(
            `INSERT INTO tasks (title, notes, due, status, done_at, done_day, project_id, parent_id, sort, created_at, updated_at, synced_at, remote_id, remote_list)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM tasks), ?, ?, ?, ?, ?)`,
            [
              r.title.trim(),
              r.notes ?? null,
              due,
              done ? "done" : "todo",
              done ? r.completed ?? stamp : null,
              done ? (r.completed ?? stamp).slice(0, 10) : null,
              parentId ? null : projectOfList.get(listId) ?? null,
              parentId,
              stamp,
              stamp,
              stamp,
              r.id,
              listId,
            ] as SqlParam[],
          );
          changed = true;
          continue;
        }
        if (local.deleted_at) continue;
        const localDirty = t(local.updated_at) > t(local.synced_at);
        const remoteNewer = t(r.updated) > t(local.synced_at);
        if (!remoteNewer || (localDirty && t(local.updated_at) >= t(r.updated))) continue;
        const differs = local.title !== (r.title ?? "") || (local.notes ?? "") !== (r.notes ?? "") || local.due !== due || (local.status === "done") !== done;
        if (!differs) {
          await db.execute("UPDATE tasks SET synced_at = ? WHERE id = ?", [now(), local.id]);
          continue;
        }
        await db.execute("UPDATE tasks SET title = ?, notes = ?, due = ? WHERE id = ?", [r.title ?? local.title, r.notes || null, due, local.id]);
        if (done && local.status !== "done") await setStatus(local.id, "done"); // also creates the next repeat
        if (!done && local.status === "done") await setStatus(local.id, "todo");
        const stamp = now();
        await db.execute("UPDATE tasks SET updated_at = ?, synced_at = ? WHERE id = ?", [stamp, stamp, local.id]);
        changed = true;
      }
    }
    state = { ...prev, lastSync: now(), lastPull: startedAt, offline: false, error: null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    state = { ...prev, offline: msg.startsWith("offline"), error: msg.startsWith("offline") ? null : msg };
  }
  await kvSet("gtasks.sync", state);
  if (changed) await notifyChanged("tasks");
  await notifyChanged("tasks-sync");
  return state;
}

export async function setTaskSyncEnabled(enabled: boolean) {
  await kvSet("gtasks.sync", { ...(await getTaskSync()), enabled });
  await notifyChanged("tasks-sync");
}
