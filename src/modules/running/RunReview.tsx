import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { forecastWeek } from "./forecast";
import { mondayOf } from "./plan";
import { RouteMap } from "./route";
import { RunMap } from "./RunMap";
import { FEELS, loadAllRunMeta, loadMyShoes, loadRunMeta, saveMyShoes, saveRunMeta, sendToGarmin, shoeKm, type MyShoe, type RunMeta } from "./runMeta";
import { duration, km, pace } from "./stats";
import { loadOverrides, type Run } from "./strava";
import { useRunningData } from "./useRunning";

const EFFORT = ["", "Very easy", "Easy", "Easy", "Moderate", "Moderate", "Hard-ish", "Hard", "Very hard", "Very hard", "All out"];

/** After a run, like Strava: give it a title, say how it felt, add notes and the shoes you wore. */
export function RunReview({ run, onClose, auto }: { run: Run; onClose: () => void; auto?: boolean }) {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const [meta, setMeta] = useState<RunMeta | null>(null);
  const [shoes, setShoes] = useState<MyShoe[]>([]);
  const [name, setName] = useState(run.name);
  const [adding, setAdding] = useState(false);
  const [newShoe, setNewShoe] = useState({ name: "", km: "0" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [map, setMap] = useState(false);
  const metas = useQuery(loadAllRunMeta, [run.id]).data;
  const overrides = useQuery(loadOverrides, []).data;
  useEffect(() => {
    Promise.all([loadRunMeta(run.id), loadMyShoes()]).then(([m, s]) => {
      setShoes(s);
      // New review: your default shoes are picked for you.
      setMeta(m.reviewed ? m : { ...m, shoe: m.shoe ?? s.find((x) => x.isDefault && !x.retired)?.id ?? null });
      if (m.name) setName(m.name);
    });
  }, [run.id]);
  const planned = plan ? forecastWeek(plan, mondayOf(run.date), runs, overrides).days.find((d) => d.date === run.date) : null;
  const kms = metas ? shoeKm(shoes, runs, metas) : new Map<string, number>();
  if (!meta) return null;
  const set = (p: Partial<RunMeta>) => setMeta({ ...meta, ...p });
  const save = async (skip = false) => {
    setBusy(true);
    const trimmed = name.trim() || run.name;
    const changedName = trimmed !== run.name;
    const next: RunMeta = skip ? { ...meta, reviewed: true } : { ...meta, name: changedName ? trimmed : meta.name, reviewed: true };
    await saveRunMeta(run.id, next);
    if (!skip && (changedName || meta.notes)) {
      const ok = await sendToGarmin(run, trimmed, meta.notes ?? "");
      if (!ok && run.id.startsWith("g")) setNote("Saved here. Garmin Connect didn't take the new title; it'll show in the app.");
    }
    setBusy(false);
    onClose();
  };
  const addShoe = async () => {
    if (!newShoe.name.trim()) return;
    const s: MyShoe = { id: `s${Date.now().toString(36)}`, name: newShoe.name.trim(), startKm: Math.max(0, +newShoe.km || 0), limitKm: /race|carbon|vapor|alpha|metaspeed|adios pro/i.test(newShoe.name) ? 500 : 800, isDefault: !shoes.some((x) => x.isDefault) };
    const all = [...shoes, s];
    await saveMyShoes(all);
    setShoes(all);
    set({ shoe: s.id });
    setAdding(false);
    setNewShoe({ name: "", km: "0" });
  };
  const when = new Date(run.start_local || run.date + "T12:00").toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return createPortal(
    <div className="modal-backdrop rr-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal rr" role="dialog" aria-label="Your run">
        <header className="rr-head">
          <span className="p-session-label">{auto ? (run.date === today ? "Nice run!" : "Your last run") : "Edit run"}</span>
          <button type="button" className="run-close" onClick={() => (auto ? save(true) : onClose())} aria-label={auto ? "Skip" : "Close"}>
            <span aria-hidden="true">✕</span>
            <span className="run-close-label">{auto ? "Skip" : "Close"}</span>
          </button>
        </header>
        <div className="rr-body">
          <div className="rr-hero">
            <div>
              <div className="rr-km num">
                {km(run.distance).toFixed(2)}
                <small>km</small>
              </div>
              <div className="rr-when">{when}</div>
            </div>
            <div className="rr-stats">
              <span>
                <b className="num">{pace(run.distance, run.moving_time)}</b>
                <small>/km</small>
              </span>
              <span>
                <b className="num">{duration(run.moving_time)}</b>
                <small>time</small>
              </span>
              {run.avg_hr ? (
                <span>
                  <b className="num">{Math.round(run.avg_hr)}</b>
                  <small>bpm</small>
                </span>
              ) : null}
            </div>
          </div>
          {run.polyline && (
            <button type="button" className="rr-map" onClick={() => setMap(true)} aria-label="Open the map">
              <RouteMap polyline={run.polyline} height={120} />
              <span className="rr-map-hint">Tap for the map</span>
            </button>
          )}
          {planned?.km ? (
            <p className="rr-planned">
              Planned: <b>{planned.text}</b>
            </p>
          ) : null}

          <label className="rr-field">
            <span>Title</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>

          <div className="rr-field">
            <span>How did it feel?</span>
            <div className="rr-feels">
              {FEELS.map((f) => (
                <button key={f.id} type="button" className={meta.feel === f.id ? "on" : ""} onClick={() => set({ feel: meta.feel === f.id ? undefined : f.id })}>
                  <i aria-hidden="true">{f.face}</i>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <label className="rr-field">
            <span>
              Effort <b>{meta.rpe ? `${meta.rpe}/10 · ${EFFORT[meta.rpe]}` : "not set"}</b>
            </span>
            <input type="range" min={1} max={10} value={meta.rpe ?? 5} onChange={(e) => set({ rpe: +e.target.value })} data-noswipe />
          </label>

          <label className="rr-field">
            <span>Notes</span>
            <textarea rows={3} value={meta.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Legs, weather, the route, anything worth remembering" />
          </label>

          <div className="rr-field">
            <span>Shoes</span>
            <div className="rr-shoes">
              {shoes
                .filter((s) => !s.retired)
                .map((s) => {
                  const k = kms.get(s.id) ?? s.startKm;
                  return (
                    <button key={s.id} type="button" className={meta.shoe === s.id ? "on" : ""} onClick={() => set({ shoe: meta.shoe === s.id ? null : s.id })}>
                      <b>{s.name}</b>
                      <small className={k > s.limitKm ? "tone-warn" : ""}>{Math.round(k)} km</small>
                    </button>
                  );
                })}
              {!adding && (
                <button type="button" className="rr-add" onClick={() => setAdding(true)}>
                  + Add shoes
                </button>
              )}
            </div>
            {adding && (
              <div className="rr-newshoe">
                <input placeholder="e.g. Nike Pegasus 41" value={newShoe.name} onChange={(e) => setNewShoe({ ...newShoe, name: e.target.value })} />
                <input type="number" min={0} inputMode="numeric" value={newShoe.km} onChange={(e) => setNewShoe({ ...newShoe, km: e.target.value })} aria-label="Kilometres already on them" />
                <button type="button" className="btn small btn-primary" onClick={addShoe} disabled={!newShoe.name.trim()}>
                  Add
                </button>
              </div>
            )}
          </div>
          {note && <p className="p-hint">{note}</p>}
        </div>
        <footer className="rr-foot">
          <button type="button" className="btn btn-primary rr-save" disabled={busy} onClick={() => save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </footer>
      </div>
      {map && run.polyline && <RunMap polyline={run.polyline} title={name} onClose={() => setMap(false)} />}
    </div>,
    document.body,
  );
}

/** Opens the review for a new run by itself (phone, when the app opens or a run arrives). */
export function AutoReview() {
  const today = useToday();
  const { runs } = useRunningData();
  const [run, setRun] = useState<Run | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!runs?.length) return;
    import("./runMeta").then(({ runToReview }) => runToReview(runs, today)).then((r) => r && !done.has(r.id) && setRun(r));
  }, [runs, today, done]);
  if (!run) return null;
  return <RunReview run={run} auto onClose={() => (setDone(new Set([...done, run.id])), setRun(null))} />;
}
