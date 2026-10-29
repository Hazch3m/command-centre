import { useCallback, useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { kvGet, kvSet } from "../../core/db";
import { useDataVersion } from "../../core/events";
import { relativeDayLabel, todayKey, useEvery, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, Empty, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import {
  addTask,
  addTaskFromText,
  compareTasks,
  createProject,
  focusGroup,
  loadProjects,
  loadTasks,
  migrations,
  PROJECT_COLOURS,
  setStatus,
  STATUSES,
  updateProject,
  type FocusGroupKey,
  type Project,
  type Status,
  type Task,
} from "./data";
import { formatEffort, parseTask, type ParsedTask } from "./parse";
import { describeRecur } from "./recur";
import { getTaskSync, syncGoogleTasks, syncMigrations } from "./gsync";
import { TaskDetail } from "./TaskDetail";
import { PRIORITY_NAME, ProjectChip, TaskRow } from "./TaskRow";

export const SYNTAX_HINT = "#project  !1-3  @due  ^start  ~45m  *weekly";

export function describeParsed(p: ParsedTask, today: string): string | null {
  const bits = [
    p.project && `#${p.project}`,
    p.priority && `${PRIORITY_NAME[p.priority]} priority`,
    p.due && `due ${relativeDayLabel(p.due, today)}`,
    p.start && `starts ${relativeDayLabel(p.start, today)}`,
    p.effort && `~${formatEffort(p.effort)}`,
    p.recur && describeRecur(p.recur).toLowerCase(),
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : null;
}

type View = "focus" | "projects" | "board";

const GROUPS: { key: FocusGroupKey; label: string; tone?: string; collapsed?: boolean }[] = [
  { key: "overdue", label: "Overdue", tone: "danger" },
  { key: "today", label: "Today", tone: "accent" },
  { key: "doing", label: "In progress", tone: "info" },
  { key: "week", label: "Next 7 days" },
  { key: "later", label: "Later" },
  { key: "nodate", label: "No date" },
  { key: "waiting", label: "Waiting on someone", tone: "warn" },
  { key: "scheduled", label: "Scheduled", collapsed: true },
];

function Section({
  label,
  tone,
  count,
  defaultOpen = true,
  children,
}: {
  label: string;
  tone?: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="task-group">
      <h3 className={tone ? `tone-${tone}` : undefined}>
        <button className="link" onClick={() => setOpen((o) => !o)}>
          {label} <span className="count">{count}</span> <span className="caret">{open ? "▾" : "▸"}</span>
        </button>
      </h3>
      {open && <ul>{children}</ul>}
    </section>
  );
}

function FocusView({ tasks, today, onOpen }: { tasks: Task[]; today: string; onOpen: (id: number) => void }) {
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");
  const grouped = new Map<FocusGroupKey, Task[]>();
  for (const t of open) {
    const g = focusGroup(t, today);
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g)!.push(t);
  }
  if (!open.length && !done.length) return <Empty>Nothing outstanding. Add a task above, or press the quick-add shortcut from any app.</Empty>;
  return (
    <>
      {GROUPS.filter((g) => grouped.has(g.key)).map((g) => (
        <Section key={g.key} label={g.label} tone={g.tone} count={grouped.get(g.key)!.length} defaultOpen={!g.collapsed}>
          {grouped
            .get(g.key)!
            .sort(compareTasks)
            .map((t) => (
              <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} />
            ))}
        </Section>
      ))}
      {done.length > 0 && (
        <Section label="Done today" count={done.length} defaultOpen={false}>
          {done.map((t) => (
            <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} />
          ))}
        </Section>
      )}
    </>
  );
}

function ProjectHeader({ p }: { p: Project }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [err, setErr] = useState<string | null>(null);
  const total = p.open + p.done;
  if (editing)
    return (
      <div className="project-edit">
        <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Project name" autoFocus
          onKeyDown={(e) => e.key === "Enter" && updateProject(p.id, { name }).then(() => setEditing(false), (x) => setErr(x.message))} />
        <span className="swatches">
          {PROJECT_COLOURS.map((c) => (
            <button key={c} className={"swatch" + (c === p.color ? " on" : "")} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => updateProject(p.id, { color: c })} />
          ))}
        </span>
        <span className="inline">
          <button className="btn btn-primary" onClick={() => updateProject(p.id, { name }).then(() => setEditing(false), (x) => setErr(x.message))}>Save</button>
          <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={() => updateProject(p.id, { archived: true })} title="Hides the project; its tasks keep it">Archive</button>
        </span>
        <ErrorNote error={err} />
      </div>
    );
  return (
    <div className="project-head">
      <span className="dot big" style={{ background: p.color }} />
      <span className="project-name">{p.name}</span>
      <span className="project-bar" title={`${p.done} done, ${p.open} open`}>
        <span style={{ width: total ? `${(p.done / total) * 100}%` : 0, background: p.color }} />
      </span>
      <span className="muted small num">{p.open} open</span>
      <button className="btn icon ghost" onClick={() => setEditing(true)} aria-label={`Edit ${p.name}`}>✎</button>
    </div>
  );
}

function ProjectsView({ tasks, projects, today, onOpen }: { tasks: Task[]; projects: Project[]; today: string; onOpen: (id: number) => void }) {
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const loose = tasks.filter((t) => !t.project_id && t.status !== "done").sort(compareTasks);
  return (
    <>
      {projects.map((p) => {
        const list = tasks.filter((t) => t.project_id === p.id && t.status !== "done").sort(compareTasks);
        return (
          <section key={p.id} className="project-block">
            <ProjectHeader p={p} />
            <ul>
              {list.map((t) => (
                <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject={false} />
              ))}
            </ul>
          </section>
        );
      })}
      {loose.length > 0 && (
        <section className="project-block">
          <div className="project-head">
            <span className="dot big" style={{ background: "var(--line-2)" }} />
            <span className="project-name muted">No project</span>
          </div>
          <ul>
            {loose.map((t) => (
              <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} showProject={false} />
            ))}
          </ul>
        </section>
      )}
      <div className="inline project-add">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="New project…" aria-label="New project"
          onKeyDown={(e) => e.key === "Enter" && draft.trim() && createProject(draft).then(() => setDraft(""), (x) => setErr(x.message))} />
        <button className="btn" disabled={!draft.trim()} onClick={() => createProject(draft).then(() => setDraft(""), (x) => setErr(x.message))}>
          Add project
        </button>
      </div>
      <ErrorNote error={err} />
    </>
  );
}

function BoardView({ tasks, today, onOpen }: { tasks: Task[]; today: string; onOpen: (id: number) => void }) {
  const [over, setOver] = useState<Status | null>(null);
  const drop = (status: Status) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = Number(e.dataTransfer.getData("text/task-id"));
    if (id) setStatus(id, status);
  };
  return (
    <div className="board">
      {STATUSES.map((s) => {
        const list = tasks.filter((t) => t.status === s.id && !(s.id !== "done" && t.start && t.start > today)).sort(compareTasks);
        return (
          <div
            key={s.id}
            className={`board-col col-${s.id}` + (over === s.id ? " drop-over" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(s.id);
            }}
            onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
            onDrop={drop(s.id)}
          >
            <h3>
              {s.id === "done" ? "Done today" : s.label} <span className="count">{list.length}</span>
            </h3>
            <ul>
              {list.map((t) => (
                <TaskRow key={t.id} task={t} today={today} onOpen={onOpen} compact draggable />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function TasksCard({ editing }: CardProps) {
  const today = useToday();
  const version = useDataVersion("tasks");
  const { data, error } = useQuery(() => Promise.all([loadTasks(today), loadProjects()]), [today, version]);
  const [view, setViewState] = useState<View>("focus");
  const [filter, setFilterState] = useState<number | "">("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);

  // Remember the chosen view and filter between launches.
  useEffect(() => {
    kvGet<{ view?: View; filter?: number | "" }>("tasks.ui", {}).then((saved) => {
      if (saved.view) setViewState(saved.view);
      if (saved.filter !== undefined) setFilterState(saved.filter);
    });
  }, []);
  const setView = (v: View) => {
    setViewState(v);
    kvSet("tasks.ui", { view: v, filter });
  };
  const setFilter = (f: number | "") => {
    setFilterState(f);
    kvSet("tasks.ui", { view, filter: f });
  };

  const tasks = data?.[0] ?? [];
  const projects = data?.[1] ?? [];
  const visible = useMemo(() => (filter === "" ? tasks : tasks.filter((t) => t.project_id === filter)), [tasks, filter]);
  const overdue = tasks.filter((t) => t.status !== "done" && focusGroup(t, today) === "overdue").length;
  const dueToday = tasks.filter((t) => t.status !== "done" && focusGroup(t, today) === "today").length;
  const doneToday = tasks.filter((t) => t.status === "done").length;
  const filterProject = projects.find((p) => p.id === filter);

  const parsed = parseTask(draft, today);
  if (filterProject && !parsed.project) parsed.project = filterProject.name;
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
  // Google Tasks: every 2 minutes, and a few seconds after any local change.
  const syncVersion = useDataVersion("tasks-sync");
  const { data: syncState } = useQuery(getTaskSync, [syncVersion]);
  useEvery(2 * 60_000, () => {
    syncGoogleTasks().catch(() => {});
  });
  useEffect(() => {
    if (!version) return;
    const t = setTimeout(() => syncGoogleTasks().catch(() => {}), 8000);
    return () => clearTimeout(t);
  }, [version]);
  const syncLabel = !syncState?.lastSync
    ? null
    : syncState.offline
      ? "Offline"
      : syncState.error
        ? "Sync problem"
        : `Synced ${new Date(syncState.lastSync).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

  const onOpen = useCallback((id: number) => !editing && setOpenId(id), [editing]);
  const close = useCallback(() => setOpenId(null), []);

  return (
    <>
      <CardHeader
        title="Tasks"
        right={
          <>
            {overdue > 0 && <span className="pill pill-danger">{overdue} overdue</span>}
            <span className="pill">{dueToday} due today</span>
            {doneToday > 0 && <span className="pill pill-accent">{doneToday} done</span>}
            {syncLabel && (
              <button
                className={"btn icon ghost sync-btn" + (syncState?.error ? " danger" : "")}
                onClick={() => syncGoogleTasks()}
                title={`Google Tasks: ${syncState?.error ?? syncLabel}. Click to sync now.`}
                aria-label="Sync with Google Tasks now"
              >
                ↻ <span className="small">{syncLabel}</span>
              </button>
            )}
          </>
        }
      />
      <div className="task-toolbar">
        <div className="segmented small-seg" role="tablist">
          {(["focus", "projects", "board"] as View[]).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
              {v === "focus" ? "Focus" : v === "projects" ? "Projects" : "Board"}
            </button>
          ))}
        </div>
        {view !== "projects" && (
          <select value={filter} onChange={(e) => setFilter(e.target.value ? Number(e.target.value) : "")} aria-label="Filter by project" className="filter">
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {filterProject && <ProjectChip name={filterProject.name} color={filterProject.color} />}
      </div>
      <div className="task-add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={filterProject ? `Add to ${filterProject.name}…` : "Add a task…"}
          aria-label="New task"
          disabled={editing}
        />
        <div className="task-add-hint muted">{preview ?? (draft ? " " : SYNTAX_HINT)}</div>
        <ErrorNote error={addErr} />
      </div>
      <ErrorNote error={error} />
      <div className={`card-scroll tasks-scroll view-${view}`}>
        {data && view === "focus" && <FocusView tasks={visible} today={today} onOpen={onOpen} />}
        {data && view === "projects" && <ProjectsView tasks={tasks} projects={projects} today={today} onOpen={onOpen} />}
        {data && view === "board" && <BoardView tasks={visible} today={today} onOpen={onOpen} />}
      </div>
      {openId != null && <TaskDetail id={openId} onClose={close} />}
    </>
  );
}

export const tasksModule: DashboardModule = {
  id: "tasks",
  title: "Tasks",
  defaultPos: { x: 0, y: 28, w: 12, h: 9 },
  minW: 4,
  minH: 3,
  migrations: [...migrations, ...syncMigrations],
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
