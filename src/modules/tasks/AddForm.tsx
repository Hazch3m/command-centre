import { useState } from "react";
import { addDays, parseKey } from "../../core/time";
import { ErrorNote } from "../../shell/ui";
import { addTask, type Project } from "./data";
import { parseTask } from "./parse";

const EFFORTS = [
  { label: "–", value: null },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 h", value: 60 },
  { label: "2 h", value: 120 },
  { label: "Half day", value: 240 },
];
const REPEATS = [
  { label: "Doesn't repeat", value: "" },
  { label: "Every day", value: "d:1" },
  { label: "Weekdays", value: "wd" },
  { label: "Every week", value: "w:1:" },
  { label: "Every 2 weeks", value: "w:2:" },
  { label: "Every month", value: "m:1" },
];

/** The coming Friday (today if it's Friday). */
const friday = (today: string) => addDays(today, (5 - parseKey(today).getDay() + 7) % 7);

/**
 * Adding a task: a title plus the key fields as proper controls. The #project
 * @due !1 shortcuts still work in the title for quick typing.
 */
export function TaskAddForm({ today, projects, defaultProject, compact }: { today: string; projects: Project[]; defaultProject?: Project; compact?: boolean }) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState<string>(defaultProject?.name ?? "");
  const [newProject, setNewProject] = useState<string | null>(null);
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<number | null>(null);
  const [effort, setEffort] = useState<number | null>(null);
  const [recur, setRecur] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(!compact);

  const reset = () => {
    setTitle("");
    setDue("");
    setPriority(null);
    setEffort(null);
    setRecur("");
    setNewProject(null);
  };
  const submit = async () => {
    if (!title.trim()) return;
    const p = parseTask(title, today);
    try {
      await addTask({
        ...p,
        project: (newProject?.trim() || project || p.project) ?? null,
        due: due || p.due,
        priority: priority ?? p.priority,
        effort: effort ?? p.effort,
        recur: recur || p.recur,
        // A repeating task needs a date to repeat from.
        ...(recur && !due && !p.due ? { due: today } : {}),
      });
      reset();
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const dueChips = [
    { label: "Today", value: today },
    { label: "Tomorrow", value: addDays(today, 1) },
    { label: "Friday", value: friday(today) },
    { label: "Next week", value: addDays(today, ((8 - parseKey(today).getDay()) % 7) || 7) },
  ];

  return (
    <div className={"task-form" + (open ? " open" : "")}>
      <div className="task-form-main">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape" && compact && !title) setOpen(false);
          }}
          placeholder={defaultProject ? `Add to ${defaultProject.name}…` : "Add a task…"}
          aria-label="New task"
        />
        <button className="btn btn-primary" disabled={!title.trim()} onClick={submit}>
          Add
        </button>
      </div>
      {open && (
        <div className="task-fields">
          <label className="field">
            <span className="label">Project</span>
            {newProject == null ? (
              <select value={project} onChange={(e) => (e.target.value === "__new" ? setNewProject("") : setProject(e.target.value))} aria-label="Project">
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.name}
                  </option>
                ))}
                <option value="__new">New project…</option>
              </select>
            ) : (
              <input value={newProject} onChange={(e) => setNewProject(e.target.value)} placeholder="Project name" aria-label="New project name" autoFocus />
            )}
          </label>
          <div className="field">
            <span className="label">Due</span>
            <div className="field-row">
              {dueChips.map((c) => (
                <button key={c.label} className={"chip-btn" + (due === c.value ? " on" : "")} onClick={() => setDue(due === c.value ? "" : c.value)}>
                  {c.label}
                </button>
              ))}
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
            </div>
          </div>
          <div className="field">
            <span className="label">Priority</span>
            <div className="field-row">
              {[
                { l: "None", v: null },
                { l: "High", v: 1 },
                { l: "Medium", v: 2 },
                { l: "Low", v: 3 },
              ].map((x) => (
                <button key={x.l} className={`chip-btn prio-chip-${x.v ?? 0}` + (priority === x.v ? " on" : "")} onClick={() => setPriority(x.v)}>
                  {x.l}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span className="label">Time</span>
            <select value={effort ?? ""} onChange={(e) => setEffort(e.target.value ? Number(e.target.value) : null)} aria-label="Estimate">
              {EFFORTS.map((x) => (
                <option key={x.label} value={x.value ?? ""}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Repeat</span>
            <select value={recur} onChange={(e) => setRecur(e.target.value)} aria-label="Repeat">
              {REPEATS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}
