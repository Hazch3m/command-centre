import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { CardHeader, ErrorNote } from "../../shell/ui";
import type { CardProps, DashboardModule } from "../types";
import { loadPlan, mondayOf } from "../running/plan";
import * as coach from "./coach";
import { defaultWeekStart, parseWeek, type Draft, type Zones } from "./importWeek";
import {
  fmtDuration,
  hrZone,
  KIND_LABEL,
  newId,
  paceParts,
  paceTarget,
  repeat,
  step,
  STEP_KINDS,
  stepPath,
  targetMode,
  totalSeconds,
  type Item,
  type Repeat,
  type Step,
  type StepKind,
  type Workout,
} from "./steps";
import { deleteTemplate, fromTemplate, getTemplates, saveTemplate } from "./templates";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmt = (d: string) => `${DOW[(parseKey(d).getDay() + 6) % 7]} ${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const emptyWorkout = (): Workout => ({ name: "", description: "", sport: "running", steps: [step("warmup", "15:00", "hr zone 2"), step("interval", "20:00", "hr zone 2"), step("cooldown", "10:00", "hr zone 2")] });

function useLink() {
  return useSyncExternalStore(coach.subscribeLink, coach.getLink);
}

/** Small light: green connected, amber connecting, red not connected or login expired. */
export function StatusLight() {
  const link = useLink();
  const { data: st } = useQuery(coach.status, [link.state]);
  const ok = link.state === "ok";
  const label =
    link.state === "login"
      ? "Garmin login expired"
      : ok
        ? "Garmin connected"
        : link.state === "connecting"
          ? "Connecting…"
          : st && !st.tokensFound
            ? "Garmin not connected (no login saved)"
            : link.state === "down"
              ? "Garmin not connected"
              : "Garmin: not checked yet";
  const tone = ok ? "on" : link.state === "connecting" || link.state === "unknown" ? "wait" : "off";
  return (
    <span className={`watch-light ${tone}`} title={link.message ?? label}>
      <i aria-hidden="true" /> {label}
    </span>
  );
}

function LoginBanner() {
  const link = useLink();
  if (link.state !== "login") return null;
  return (
    <div className="watch-banner" role="alert">
      <b>Garmin login expired, run python login.py in garmin-coach-mcp</b>
      <span className="small">Open a terminal in the garmin-coach-mcp folder, activate its .venv and run it; then press Retry.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Garmin calendar: this week and next

function useScheduled(from: string, to: string, tick: number) {
  return useQuery(async () => {
    const r = await coach.getScheduled(from, to);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  }, [from, to, tick]);
}

function GarminWeeks({ tick, onChanged, onReplace }: { tick: number; onChanged: () => void; onReplace: (s: coach.Scheduled) => void }) {
  const today = useToday();
  const mon = mondayOf(today);
  const { data, error, loading } = useScheduled(mon, addDays(mon, 13), tick);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const remove = async (s: coach.Scheduled) => {
    if (armed !== s.scheduleId) {
      setArmed(s.scheduleId);
      window.setTimeout(() => setArmed((a) => (a === s.scheduleId ? null : a)), 4000);
      return;
    }
    setBusy(s.scheduleId);
    setErr(null);
    const r = await coach.unschedule(s.scheduleId);
    setBusy(null);
    setArmed(null);
    if (!r.ok) setErr(r.message);
    onChanged();
  };
  return (
    <section className="watch-weeks">
      <ErrorNote error={err ?? error} />
      {[0, 1].map((w) => (
        <div key={w} className="watch-week">
          <div className="watch-week-label">
            <b>{w === 0 ? "This week" : "Next week"}</b> <span className="muted small">{fmt(addDays(mon, 7 * w))} – {fmt(addDays(mon, 7 * w + 6))}</span>
          </div>
          <div className="watch-days">
            {Array.from({ length: 7 }, (_, i) => addDays(mon, 7 * w + i)).map((d) => {
              const items = (data ?? []).filter((s) => s.date === d);
              return (
                <div key={d} className={"watch-day" + (d === today ? " today" : "") + (d < today ? " past" : "") + (items.length > 1 ? " double" : "")}>
                  <div className="watch-day-head">
                    <b>{DOW[i]}</b> <span className="muted">{parseKey(d).getDate()}</span>
                    {items.length > 1 && (
                      <span className="watch-double" title="More than one workout on this day">
                        {items.length} workouts
                      </span>
                    )}
                  </div>
                  {items.map((s) => (
                    <div key={s.scheduleId} className="watch-item">
                      <span className="watch-item-name" title={s.name}>
                        {s.name}
                      </span>
                      <span className="watch-item-actions">
                        <button className="btn icon ghost" onClick={() => onReplace(s)} title="Change this workout (updates it in place)" aria-label={`Change ${s.name}`}>
                          ✎
                        </button>
                        <button
                          className={"btn icon ghost" + (armed === s.scheduleId ? " danger" : "")}
                          disabled={busy === s.scheduleId}
                          onClick={() => remove(s)}
                          title={armed === s.scheduleId ? "Click again to remove it from the calendar" : "Remove from the Garmin calendar"}
                          aria-label={`Remove ${s.name}`}
                        >
                          {armed === s.scheduleId ? "Remove?" : "✕"}
                        </button>
                      </span>
                    </div>
                  ))}
                  {!items.length && !loading && <span className="muted small">–</span>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Builder

function TargetEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const mode = targetMode(value);
  const [a, b] = paceParts(value);
  return (
    <span className="watch-target">
      <select
        value={mode}
        onChange={(e) => {
          const m = e.target.value;
          onChange(m === "open" ? "open" : m === "pace" ? paceTarget(a || "4:50", b || "5:05") : m === "hrzone" ? "hr zone 2" : value === "open" ? "hr 140-150" : value);
        }}
        aria-label="Target"
      >
        <option value="open">No target</option>
        <option value="hrzone">HR zone</option>
        <option value="pace">Pace (min/km)</option>
        <option value="custom">Other…</option>
      </select>
      {mode === "pace" && (
        <>
          <input className="watch-pace" value={a} onChange={(e) => onChange(paceTarget(e.target.value, b))} placeholder="4:50" aria-label="Fastest pace" />
          <span className="muted">–</span>
          <input className="watch-pace" value={b} onChange={(e) => onChange(paceTarget(a, e.target.value))} placeholder="5:05" aria-label="Slowest pace" />
          <span className="muted small">/km</span>
        </>
      )}
      {mode === "hrzone" && (
        <select value={hrZone(value)} onChange={(e) => onChange(`hr zone ${e.target.value}`)} aria-label="Heart-rate zone">
          {[1, 2, 3, 4, 5].map((z) => (
            <option key={z} value={z}>
              Zone {z}
            </option>
          ))}
        </select>
      )}
      {mode === "custom" && <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="hr 140-150" aria-label="Target" />}
    </span>
  );
}

function StepRow({
  s,
  path,
  bad,
  onChange,
  onRemove,
  onMove,
}: {
  s: Step;
  path: string;
  bad?: string | null;
  onChange: (s: Step) => void;
  onRemove: () => void;
  onMove: (d: -1 | 1) => void;
}) {
  return (
    <div className={`watch-step k-${s.kind}` + (bad ? " bad" : "")}>
      <span className="watch-step-path muted small">{path}</span>
      <select value={s.kind} onChange={(e) => onChange({ ...s, kind: e.target.value as StepKind })} aria-label="Step kind">
        {STEP_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <input className="watch-dur" value={s.duration} onChange={(e) => onChange({ ...s, duration: e.target.value })} placeholder="10:00, 800m, 5km, lap" aria-label="Duration" list="watch-durations" />
      <TargetEditor value={s.target} onChange={(t) => onChange({ ...s, target: t })} />
      <input className="watch-notes" value={s.notes ?? ""} onChange={(e) => onChange({ ...s, notes: e.target.value })} placeholder="Cue on the watch" aria-label="Notes" />
      <span className="watch-step-btns">
        <button className="btn icon ghost" onClick={() => onMove(-1)} aria-label="Move up" title="Move up">
          ↑
        </button>
        <button className="btn icon ghost" onClick={() => onMove(1)} aria-label="Move down" title="Move down">
          ↓
        </button>
        <button className="btn icon ghost" onClick={onRemove} aria-label="Remove step" title="Remove">
          ✕
        </button>
      </span>
      {bad && <div className="watch-step-error">{bad}</div>}
    </div>
  );
}

function move<T>(xs: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= xs.length) return xs;
  const out = [...xs];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export interface Target {
  /** Update this saved workout in place instead of creating a new one. */
  workoutId?: number;
  /** Its calendar entry, when it came from the calendar. */
  scheduled?: coach.Scheduled;
}

function Builder({
  w,
  setW,
  target,
  setTarget,
  date,
  setDate,
  bad,
  onPreview,
}: {
  w: Workout;
  setW: (w: Workout) => void;
  target: Target;
  setTarget: (t: Target) => void;
  date: string;
  setDate: (d: string) => void;
  bad: { id: string; message: string } | null;
  onPreview: () => void;
}) {
  const { data: templates, reload } = useQuery(getTemplates, []);
  const [tpl, setTpl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const items = w.steps;
  const setItems = (steps: Item[]) => setW({ ...w, steps });
  const setItem = (i: number, it: Item) => setItems(items.map((x, j) => (j === i ? it : x)));
  const add = (kind: StepKind | "repeat") =>
    setItems([...items, kind === "repeat" ? repeat(4, [step("interval", "1km", "pace 3:50-4:00/km"), step("recovery", "2:00", "open")]) : step(kind, kind === "interval" ? "1km" : "10:00", kind === "warmup" || kind === "cooldown" ? "hr zone 2" : "open")]);
  return (
    <section className="watch-builder">
      <div className="watch-builder-top">
        <label className="grow">
          <span className="label">Name</span>
          <input value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} placeholder="e.g. Threshold 3×10 min @ 3:40–3:48" />
        </label>
        <label>
          <span className="label">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          <span className="label">Template</span>
          <span className="inline">
            <select
              value={tpl}
              onChange={(e) => {
                const t = templates?.find((x) => x.name === e.target.value);
                setTpl(e.target.value);
                if (t) {
                  setW(fromTemplate(t));
                  setTarget({});
                }
              }}
            >
              <option value="">Start from…</option>
              {templates?.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                  {t.builtIn ? "" : " (yours)"}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!w.name.trim()}
              onClick={() => saveTemplate(w).then(() => (reload(), setMsg(`Saved “${w.name.trim()}” as a template.`)))}
              title="Save these steps as a template under this name"
            >
              Save as template
            </button>
            {tpl && templates?.find((t) => t.name === tpl && !t.builtIn) && (
              <button className="btn ghost" onClick={() => deleteTemplate(tpl).then(() => (setTpl(""), reload()))}>
                Delete template
              </button>
            )}
          </span>
        </label>
      </div>
      {target.workoutId != null && (
        <div className="watch-updating small">
          Changing <b>{target.scheduled?.name ?? `workout ${target.workoutId}`}</b>
          {target.scheduled ? ` (${fmt(target.scheduled.date)})` : ""}: Confirm updates it in place, so its calendar slot stays.{" "}
          <button className="link" onClick={() => setTarget({})}>
            Make a new workout instead
          </button>
        </div>
      )}
      <label className="watch-desc">
        <span className="label">Notes (cues for the whole workout)</span>
        <textarea rows={2} value={w.description} onChange={(e) => setW({ ...w, description: e.target.value })} placeholder="What it's for, how it should feel, fuelling…" />
      </label>
      <datalist id="watch-durations">
        {["5:00", "10:00", "15:00", "20:00", "90s", "60s", "400m", "800m", "1km", "2km", "5km", "10km", "lap"].map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div className="watch-steps">
        {items.map((it, i) =>
          it.kind === "repeat" ? (
            <div key={it.id} className={"watch-repeat" + (bad?.id === it.id ? " bad" : "")}>
              <div className="watch-repeat-head">
                <span className="watch-step-path muted small">Step {i + 1}</span>
                <b>Repeat</b>
                <input
                  type="number"
                  min={1}
                  className="watch-times"
                  value={it.times}
                  onChange={(e) => setItem(i, { ...it, times: Math.max(1, Math.round(+e.target.value || 1)) })}
                  aria-label="Times"
                />
                <span>times</span>
                <span className="watch-step-btns">
                  <button className="btn ghost small" onClick={() => setItem(i, { ...it, steps: [...it.steps, step("recovery", "2:00", "open")] } as Repeat)}>
                    + step inside
                  </button>
                  <button className="btn icon ghost" onClick={() => setItems(move(items, i, -1))} aria-label="Move up">
                    ↑
                  </button>
                  <button className="btn icon ghost" onClick={() => setItems(move(items, i, 1))} aria-label="Move down">
                    ↓
                  </button>
                  <button className="btn icon ghost" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Remove repeat">
                    ✕
                  </button>
                </span>
                {bad?.id === it.id && <div className="watch-step-error">{bad.message}</div>}
              </div>
              {it.steps.map((s, k) => (
                <StepRow
                  key={s.id}
                  s={s}
                  path={`${i + 1}.${k + 1}`}
                  bad={bad?.id === s.id ? bad.message : null}
                  onChange={(ns) => setItem(i, { ...it, steps: it.steps.map((x, j) => (j === k ? ns : x)) })}
                  onRemove={() => setItem(i, { ...it, steps: it.steps.filter((_, j) => j !== k) })}
                  onMove={(d) => setItem(i, { ...it, steps: move(it.steps, k, d) })}
                />
              ))}
            </div>
          ) : (
            <StepRow
              key={it.id}
              s={it}
              path={String(i + 1)}
              bad={bad?.id === it.id ? bad.message : null}
              onChange={(ns) => setItem(i, ns)}
              onRemove={() => setItems(items.filter((_, j) => j !== i))}
              onMove={(d) => setItems(move(items, i, d))}
            />
          ),
        )}
      </div>
      <div className="watch-add">
        <span className="muted small">Add</span>
        {(["warmup", "interval", "recovery", "rest", "cooldown", "other"] as StepKind[]).map((k) => (
          <button key={k} className="btn" onClick={() => add(k)}>
            + {KIND_LABEL[k]}
          </button>
        ))}
        <button className="btn" onClick={() => add("repeat")}>
          + Repeat
        </button>
        <span className="muted small watch-total">≈ {fmtDuration(totalSeconds(items))} of timed and paced steps</span>
      </div>
      <ErrorNote error={msg} />
      <div className="watch-builder-foot">
        <span className="muted small">Easy running: HR zones. Quality: pace ranges in min/km. Durations like 10:00, 90s, 800m, 5km or lap.</span>
        <button className="btn btn-primary" disabled={!w.name.trim() || !items.length} onClick={onPreview}>
          Preview
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Preview and confirm (the only way anything reaches Garmin)

interface Pending {
  w: Workout;
  date: string;
  target: Target;
  summary: string;
  draftKey?: string;
}

function ConfirmDialog({ p, onClose, onDone }: { p: Pending; onClose: () => void; onDone: (msg: string) => void }) {
  const [date, setDate] = useState(p.date);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [alongside, setAlongside] = useState(false);
  const [useSame, setUseSame] = useState(true);
  const day = useQuery(async () => {
    if (!date) return [] as coach.Scheduled[];
    const r = await coach.getScheduled(date, date);
    if (!r.ok) throw new Error(r.message);
    return r.data;
  }, [date]);
  const existing = day.data ?? [];
  const updating = p.target.workoutId != null;
  const same = existing.find((s) => s.name.trim().toLowerCase() === p.w.name.trim().toLowerCase());
  const others = existing.filter((s) => s !== same && s.workoutId !== p.target.workoutId);
  // Rule: no duplicates. The same workout on that day is updated, not added again.
  const willUpdate = updating ? p.target.workoutId! : same && useSame ? same.workoutId : null;
  const blocked = !updating && !willUpdate && others.length > 0 && !alongside;
  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (willUpdate != null) {
        const r = await coach.update(willUpdate, p.w);
        if (!r.ok) throw new Error(r.message);
        await coach.remember(willUpdate, p.w);
        // A workout changed from the calendar can also move day.
        const sched = p.target.scheduled ?? same;
        if (updating && date && sched && sched.date !== date) {
          const s = await coach.call("schedule_workout", { workout_id: willUpdate, date });
          if (!s.ok) throw new Error(s.message);
          await coach.unschedule(sched.scheduleId);
        } else if (updating && date && !sched) {
          const s = await coach.call("schedule_workout", { workout_id: willUpdate, date });
          if (!s.ok) throw new Error(s.message);
        }
        onDone(`Updated “${p.w.name}”${date ? ` (${fmt(date)})` : ""}. It reaches the watch on its next sync.`);
      } else {
        const r = await coach.create(p.w, date || undefined);
        if (!r.ok) throw new Error(r.message);
        await coach.remember(r.data.workoutId, p.w);
        onDone(date ? `“${p.w.name}” is on your Garmin calendar for ${fmt(date)}. It reaches the watch on its next sync.` : `“${p.w.name}” is saved in Garmin Connect.`);
      }
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal watch-confirm" role="dialog" aria-label="Confirm workout">
        <header className="modal-header">
          <h2>{updating || willUpdate != null ? "Update on Garmin?" : "Put on Garmin?"}</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="label">What garmin-coach will send (preview)</div>
        <pre className="watch-summary">{p.summary}</pre>
        {p.w.description && <div className="small muted">Notes: {p.w.description}</div>}
        <label className="watch-confirm-date">
          <span className="label">Day</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          {!date && <span className="muted small">No date: saved to your workouts only.</span>}
        </label>
        {date && (
          <div className="watch-daycheck small">
            {day.loading ? (
              <span className="muted">Checking {fmt(date)} on your Garmin calendar…</span>
            ) : day.error ? (
              <span className="tone-danger">Couldn't check the calendar: {day.error}</span>
            ) : !existing.length ? (
              <span className="tone-accent">{fmt(date)} is free.</span>
            ) : (
              <>
                <div>
                  Already on {fmt(date)}: <b>{existing.map((s) => s.name).join(", ")}</b>
                </div>
                {!updating && same && (
                  <div className="watch-choice">
                    <label className="inline">
                      <input type="radio" checked={useSame} onChange={() => setUseSame(true)} /> Update that one in place (no duplicate)
                    </label>
                    <label className="inline">
                      <input type="radio" checked={!useSame} onChange={() => setUseSame(false)} /> Add a second copy
                    </label>
                  </div>
                )}
                {!updating && willUpdate == null && others.length > 0 && (
                  <label className="inline watch-alongside">
                    <input type="checkbox" checked={alongside} onChange={(e) => setAlongside(e.target.checked)} /> Yes, add it alongside (two workouts that day)
                  </label>
                )}
              </>
            )}
          </div>
        )}
        <ErrorNote error={err} />
        <footer className="modal-footer">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={busy || blocked || day.loading} onClick={confirm}>
            {busy ? "Sending…" : willUpdate != null ? "Confirm: update" : date ? "Confirm: add to calendar" : "Confirm: save"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Import week

function ImportWeek({ onPreview, onEdit, done }: { onPreview: (d: Draft) => void; onEdit: (d: Draft) => void; done: Set<string> }) {
  const today = useToday();
  const { data: plan } = useQuery(loadPlan, []);
  const zones: Zones = useMemo(() => {
    const p = plan?.plan.paces ?? [];
    const z = (re: RegExp) => p.find((x) => re.test(x.zone))?.now;
    return { MP: z(/^Marathon pace/i), HMP: z(/^Half marathon pace/i), T: z(/^Threshold/i) };
  }, [plan]);
  const [text, setText] = useState("");
  const [week, setWeek] = useState(defaultWeekStart(today));
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const make = () => {
    setDrafts(parseWeek(text, week, zones));
    setSkipped(new Set());
  };
  return (
    <section className="watch-import">
      <div className="watch-import-top">
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Paste next week's sessions from the Monday review email, one day per line:\nMon: Rest\nTue: 4 × 6 min T at 3:46–3:50, 1 min jog\nWed: 10 km easy + strength A\nSun: 22 km easy"}
        />
        <div className="watch-import-side">
          <label>
            <span className="label">Week of</span>
            <select value={week} onChange={(e) => setWeek(e.target.value)}>
              {[-7, 0, 7, 14].map((n) => {
                const m = addDays(defaultWeekStart(today), n);
                return (
                  <option key={m} value={m}>
                    {fmt(m)}
                  </option>
                );
              })}
            </select>
          </label>
          <button className="btn btn-primary" disabled={!text.trim()} onClick={make}>
            Make drafts
          </button>
          <span className="muted small">Nothing is sent until you preview and confirm each one.</span>
        </div>
      </div>
      {drafts.length > 0 && (
        <div className="watch-drafts">
          {drafts
            .filter((d) => !skipped.has(d.key))
            .map((d) => (
              <div key={d.key} className={"watch-draft" + (done.has(d.key) ? " done" : "")}>
                <div className="watch-draft-head">
                  <b>{fmt(d.date)}</b> {d.name}
                  {done.has(d.key) && <span className="tone-accent small"> ✓ on Garmin</span>}
                </div>
                <div className="muted small">{d.source}</div>
                <div className="watch-draft-steps small">{summarise(d.steps)}</div>
                {d.warning && <div className="tone-warn small">{d.warning}</div>}
                <div className="watch-draft-btns">
                  <button className="btn btn-primary" disabled={done.has(d.key)} onClick={() => onPreview(d)}>
                    Preview & confirm
                  </button>
                  <button className="btn" onClick={() => onEdit(d)}>
                    Edit in builder
                  </button>
                  <button className="btn ghost" onClick={() => setSkipped(new Set([...skipped, d.key]))}>
                    Skip
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
      {text.trim() && !drafts.length && <p className="muted small">Lines need to start with the day (Mon, Tuesday, Wed 11 Nov…).</p>}
    </section>
  );
}

function summarise(items: Item[]): string {
  return items
    .map((it) => (it.kind === "repeat" ? `${it.times}× (${it.steps.map((s) => `${s.duration}${s.target !== "open" ? ` ${s.target}` : ""}`).join(" + ")})` : `${KIND_LABEL[it.kind]} ${it.duration}${it.target !== "open" ? ` ${it.target}` : ""}`))
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Settings: where garmin-coach is

export function WatchSetting() {
  const { data: saved, reload } = useQuery(coach.getWatchSettings, []);
  const [folder, setFolder] = useState("");
  const [python, setPython] = useState("");
  useEffect(() => {
    if (saved) {
      setFolder(saved.folder);
      setPython(saved.python);
    }
  }, [saved]);
  const { data: st, reload: recheck } = useQuery(coach.status, [saved?.folder, saved?.python]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    await coach.saveWatchSettings({ folder: folder.trim(), python: python.trim() });
    reload();
    recheck();
  };
  const test = async () => {
    setBusy(true);
    setMsg(null);
    await save();
    try {
      const tools = await coach.listTools();
      const today = new Date().toISOString().slice(0, 10);
      const r = await coach.getScheduled(today, today);
      setMsg(r.ok ? `Connected: ${tools.length} tools (${tools.map((t) => t.name).join(", ")}).` : r.message);
    } catch (e) {
      setMsg(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
      recheck();
    }
  };
  return (
    <div className="watch-setting">
      <div className="watch-setting-row">
        <label>
          <span className="label">garmin-coach folder (with server.py)</span>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={st?.folder || "%USERPROFILE%\\Downloads\\garmin-coach-mcp\\garmin-coach-mcp"} />
        </label>
        <label>
          <span className="label">Python (optional)</span>
          <input value={python} onChange={(e) => setPython(e.target.value)} placeholder={st?.python ?? "the folder's .venv\\Scripts\\python.exe"} />
        </label>
        <button className="btn" onClick={save}>
          Save
        </button>
        <button className="btn btn-primary" disabled={busy} onClick={test}>
          {busy ? "Connecting…" : "Test connection"}
        </button>
      </div>
      {st && (
        <ul className="watch-checks small">
          <li className={st.serverFound ? "ok" : "bad"}>{st.serverFound ? `server.py found in ${st.folder}` : `No server.py in ${st.folder || "the usual places"}`}</li>
          <li className={st.python ? "ok" : "bad"}>{st.python ? `Python: ${st.python}` : "No Python with garmin-coach's packages (its .venv). See its README: python -m venv .venv, then pip install -r requirements.txt"}</li>
          <li className={st.tokensFound ? "ok" : "bad"}>{st.tokensFound ? `Garmin login saved in ${st.tokensDir}` : `No Garmin login in ${st.tokensDir}: run python login.py in the garmin-coach folder`}</li>
          {st.stderr.length > 0 && <li className="muted">Server said: {st.stderr.slice(-2).join(" · ")}</li>}
        </ul>
      )}
      <ErrorNote error={msg && !/^Connected/.test(msg) ? msg : null} />
      {msg && /^Connected/.test(msg) && <div className="tone-accent small">{msg}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The page and the tile

function WatchPage() {
  const today = useToday();
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const [w, setW] = useState<Workout>(emptyWorkout);
  const [target, setTarget] = useState<Target>({});
  const [date, setDate] = useState(addDays(today, 1));
  const [bad, setBad] = useState<{ id: string; message: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const link = useLink();

  // Rule 1: always preview first; only the confirm dialog sends anything.
  const preview = async (wk: Workout, d: string, t: Target, draftKey?: string) => {
    setBusy(true);
    setErr(null);
    setBad(null);
    setNotice(null);
    const r = await coach.preview(wk);
    if (r.ok) {
      setPending({ w: wk, date: d, target: t, summary: r.data ?? r.text, draftKey });
    } else if (r.kind === "invalid") {
      // Rule 5: show which step is wrong.
      const where = await coach.findBadStep(wk);
      if (where) {
        setW(wk);
        setTarget(t);
        setDate(d);
        setBad(where);
        setErr(`Invalid workout: ${stepPath(wk.steps, where.id) ?? "a step"}: ${where.message}`);
      } else setErr(r.message);
    } else setErr(r.message);
    setBusy(false);
  };

  const replace = async (s: coach.Scheduled) => {
    // Rule 3: changing a workout on the calendar updates it rather than adding a new one.
    const saved = (await coach.getSaved())[String(s.workoutId)];
    if (saved) setW({ ...saved, steps: saved.steps });
    else {
      const desc = await coach.getWorkout(s.workoutId);
      setW({ name: s.name, description: "", sport: "running", steps: emptyWorkout().steps });
      setNotice(
        desc.ok
          ? `This workout wasn't made here, so its steps can't be loaded for editing. Garmin has:\n${desc.data}\nBuild the new version below; Confirm replaces it in place.`
          : `Build the new version of “${s.name}” below; Confirm replaces it in place.`,
      );
    }
    setTarget({ workoutId: s.workoutId, scheduled: s });
    setDate(s.date);
    setBad(null);
    document.querySelector(".watch-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="subpage watch-page">
      <header className="page-head">
        <div>
          <h1>Watch</h1>
          <div className="muted small">Build workouts and put them on your Garmin calendar through your garmin-coach server. They reach the watch on its next sync.</div>
        </div>
        <span className="inline">
          <StatusLight />
          {link.state !== "ok" && (
            <button className="btn" onClick={refresh}>
              Retry
            </button>
          )}
        </span>
      </header>
      <LoginBanner />

      <h3>Your Garmin calendar</h3>
      <GarminWeeks tick={tick} onChanged={refresh} onReplace={replace} />

      <h3>Build a workout</h3>
      {notice && <pre className="watch-notice small">{notice}</pre>}
      <ErrorNote error={err} />
      <Builder
        w={w}
        setW={(x) => (setW(x), setBad(null))}
        target={target}
        setTarget={setTarget}
        date={date}
        setDate={setDate}
        bad={bad}
        onPreview={() => preview(w, date, target)}
      />
      {busy && <div className="muted small">Asking garmin-coach for a preview…</div>}

      <h3>Import week</h3>
      <ImportWeek
        done={done}
        onPreview={(d) => preview(d, d.date, {}, d.key)}
        onEdit={(d) => {
          setW({ name: d.name, description: d.description, sport: d.sport, steps: d.steps.map((s) => ({ ...s, id: newId() })) });
          setTarget({});
          setDate(d.date);
          document.querySelector(".watch-builder")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />

      <details className="fold">
        <summary>
          <h3>garmin-coach server</h3>
          <span className="muted small">where it is and which Python runs it</span>
        </summary>
        <WatchSetting />
      </details>

      {pending && (
        <ConfirmDialog
          p={pending}
          onClose={() => setPending(null)}
          onDone={(m) => {
            if (pending.draftKey) setDone(new Set([...done, pending.draftKey]));
            setPending(null);
            setTarget({});
            setNotice(m);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function WatchTile({ editing }: CardProps) {
  const today = useToday();
  const { data, error } = useScheduled(today, addDays(today, 6), 0);
  return (
    <>
      <CardHeader title="Watch" to={editing ? undefined : "watch"} right={<StatusLight />} />
      <LoginBanner />
      {error ? (
        <div className="muted small">{error}</div>
      ) : (
        <ul className="watch-tile-list">
          {(data ?? []).map((s) => (
            <li key={s.scheduleId}>
              <span className="muted">{s.date === today ? "Today" : fmt(s.date)}</span> {s.name}
            </li>
          ))}
          {data && !data.length && <li className="muted">Nothing on the Garmin calendar this week.</li>}
        </ul>
      )}
    </>
  );
}

export const watchModule: DashboardModule = {
  id: "watch",
  title: "Watch",
  defaultPos: { x: 0, y: 0, w: 4, h: 6 },
  defaultHidden: true,
  minW: 3,
  minH: 3,
  Card: WatchTile,
  page: { label: "Watch", order: 1.5, Page: WatchPage },
};
