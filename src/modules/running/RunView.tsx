import { predictionChange } from "./goalTrend";
import { workoutLaps } from "../../phone/EffortProfile";
import { useEffect, useMemo, useState, type ReactNode, useRef } from "react";
import { useSwipe } from "../../phone/swipe";
import { RunMap, RunMapThumb } from "./RunMap";
import { RunReview } from "./RunReview";
import { RunFocus } from "../../phone/Focus";
import { FEELS, loadAllRunMeta, loadMyShoes } from "./runMeta";
import { createPortal } from "react-dom";
import { backend } from "@backend";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, relativeDayLabel, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { XYChart } from "../../shell/charts";
import { ErrorNote } from "../../shell/ui";
import { forecastWeek } from "./forecast";
import { checkRun, fmtPace, fmtVal, verdictLabel } from "./pace";
import { loadPlan, type Plan } from "./plan";
import { MedalBadges } from "./Medals";
import { collectEfforts, medalsByRun } from "./pbs";
import { RunTypeDot, typeOfDay, typeOfRun } from "./runType";
import { duration, km, pace } from "./stats";
import { loadDetails, loadFullRun, loadOverrides, loadRuns, loadShoes, type FullRun, type Run } from "./strava";

/** Open a run or a week from anywhere (the host lives in the dashboard shell). */
export const openRun = (id: string) => window.dispatchEvent(new CustomEvent("cc:run-view", { detail: { kind: "run", id } }));
export const openWeek = (monday: string) => window.dispatchEvent(new CustomEvent("cc:run-view", { detail: { kind: "week", id: monday } }));

type View = { kind: "run" | "week"; id: string };

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDay = (d: string) => `${DOW[parseKey(d).getDay()]} ${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const paceOf = (speed: number) => (speed > 0 ? fmtPace(1000 / speed) : "–");

/** Opens the run where it came from: Garmin Connect ("g…" ids) or Strava. */
export function openSource(id: string) {
  return id.startsWith("g") ? backend.openGarminActivity(id.slice(1)) : backend.openStravaActivity(id);
}

export function RunViewHost() {
  const [stack, setStack] = useState<View[]>([]);
  useEffect(() => {
    const f = (e: Event) => setStack((s) => [...s, (e as CustomEvent<View>).detail]);
    window.addEventListener("cc:run-view", f);
    return () => window.removeEventListener("cc:run-view", f);
  }, []);
  useEffect(() => {
    if (!stack.length) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && setStack((s) => s.slice(0, -1));
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [stack.length]);
  // On a phone: swipe right to go back (or close), as anywhere else in the app.
  const sheet = useRef<HTMLDivElement | null>(null);
  useSwipe(sheet, () => setStack((s) => s.slice(0, -1)), (d) => d === -1);
  const top = stack[stack.length - 1];
  if (!top) return null;
  const back = () => setStack((s) => s.slice(0, -1));
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setStack([])}>
      <div ref={sheet} className="modal run-modal" role="dialog">
        {top.kind === "week" ? <WeekRuns monday={top.id} onBack={stack.length > 1 ? back : undefined} onClose={() => setStack([])} /> : <RunDetail id={top.id} onBack={stack.length > 1 ? back : undefined} onClose={() => setStack([])} />}
      </div>
    </div>,
    document.body,
  );
}

function Head({ title, sub, onBack, onClose, right }: { title: string; sub?: string; onBack?: () => void; onClose: () => void; right?: ReactNode }) {
  return (
    <header className="modal-header run-head">
      <div className="run-head-title">
        {onBack && (
          <button className="btn icon ghost" onClick={onBack} aria-label="Back">
            ‹
          </button>
        )}
        <div>
          <h2>{title}</h2>
          {sub && <div className="muted small">{sub}</div>}
        </div>
      </div>
      <div className="inline">
        {right}
        <button className="btn icon ghost run-close" onClick={onClose} aria-label="Close">
          <span aria-hidden="true">✕</span>
          <span className="run-close-label">Close</span>
        </button>
      </div>
    </header>
  );
}

function WeekRuns({ monday, onBack, onClose }: { monday: string; onBack?: () => void; onClose: () => void }) {
  const today = useToday();
  const version = useDataVersion("running");
  const { data } = useQuery(() => Promise.all([loadRuns(monday), loadPlan(), loadOverrides(), loadDetails(monday)]), [version, monday]);
  const [m, setM] = useState(monday);
  useEffect(() => setM(monday), [monday]);
  if (!data) return <Head title="Week" onClose={onClose} onBack={onBack} />;
  const [all, { plan }, overrides, details] = data;
  const runs = all.filter((r) => r.date >= m && r.date <= addDays(m, 6));
  const fw = forecastWeek(plan, m, runs, overrides);
  const total = runs.reduce((s, r) => s + r.distance, 0);
  const time = runs.reduce((s, r) => s + r.moving_time, 0);
  const longest = runs.reduce((x, r) => Math.max(x, r.distance), 0);
  return (
    <>
      <Head
        title={`Week of ${fmtDay(m)}`}
        sub={fw.week ? `Plan week ${fw.week.week} · ${fw.week.km} km planned` : fw.block ? fw.block.name : undefined}
        onBack={onBack}
        onClose={onClose}
        right={
          <>
            <button className="btn icon" onClick={() => setM(addDays(m, -7))} aria-label="Previous week">
              ‹
            </button>
            <button className="btn icon" onClick={() => setM(addDays(m, 7))} disabled={m >= today} aria-label="Next week">
              ›
            </button>
          </>
        }
      />
      <div className="run-stats">
        <Stat label="Distance" value={`${km(total).toFixed(1)} km`} />
        <Stat label="Runs" value={String(runs.length)} />
        <Stat label="Time" value={duration(time)} />
        <Stat label="Average pace" value={total ? `${pace(total, time)}/km` : "–"} />
        <Stat label="Longest" value={longest ? `${km(longest).toFixed(1)} km` : "–"} />
      </div>
      <table className="table run-list">
        <thead>
          <tr>
            <th>Day</th>
            <th>Planned</th>
            <th>Run</th>
            <th className="num-col">km</th>
            <th className="num-col">Time</th>
            <th className="num-col">Pace</th>
            <th className="num-col">HR</th>
            <th>Pace on point</th>
          </tr>
        </thead>
        <tbody>
          {fw.days.map((d) => {
            const rs = d.runs.length ? d.runs : [null];
            return rs.map((r, i) => {
              const c = r ? checkRun(d, r, details.get(r.id) ?? null) : null;
              return (
                <tr key={d.date + (r?.id ?? "")} className={r ? "clickable" : "muted"} onClick={r ? () => openRun(r.id) : undefined}>
                  <td className="nowrap">{i === 0 ? fmtDay(d.date) : ""}</td>
                  <td className="muted">
                    {i === 0 && fw.week ? <RunTypeDot type={typeOfDay(d.kind)} /> : null} {i === 0 ? d.text || "–" : ""}
                  </td>
                  <td>
                    {r ? (
                      <>
                        <RunTypeDot type={typeOfRun(r, fw.week ? d.kind : null)} label /> {r.name}
                      </>
                    ) : d.date <= today && d.km ? (
                      "not run"
                    ) : (
                      ""
                    )}
                  </td>
                  <td className="num-col">{r ? km(r.distance).toFixed(1) : ""}</td>
                  <td className="num-col">{r ? duration(r.moving_time) : ""}</td>
                  <td className="num-col">{r ? pace(r.distance, r.moving_time) : ""}</td>
                  <td className="num-col">{r?.avg_hr ? Math.round(r.avg_hr) : ""}</td>
                  <td>{c ? <span className={c.verdict === "on-point" ? "tone-accent" : c.verdict.startsWith("slightly") ? "tone-warn" : "tone-danger"}>{verdictLabel(c)}</span> : ""}</td>
                </tr>
              );
            });
          })}
        </tbody>
      </table>
      <p className="muted small">Click a run for its laps, splits and charts.</p>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="run-stat">
      <div className="label">{label}</div>
      <div className="num run-stat-value">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

/** Thins a stream to at most `n` points, averaging within each bucket. */
function thin(xs: number[], ys: number[], n = 400): [number, number][] {
  const out: [number, number][] = [];
  const step = Math.max(1, Math.floor(xs.length / n));
  for (let i = 0; i < xs.length; i += step) {
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let j = i; j < Math.min(xs.length, i + step); j++)
      if (Number.isFinite(ys[j])) {
        sx += xs[j];
        sy += ys[j];
        c++;
      }
    if (c) out.push([sx / c, sy / c]);
  }
  return out;
}

/** A workout's laps by name: each rep with its time, pace against the target, heart rate; and the reps on average. */
function WorkoutLapsView({ laps, planned, plan }: { laps: FullRun["laps"]; planned?: string | null; plan: Plan }) {
  const wl = useMemo(() => workoutLaps(laps, planned, plan), [laps, planned, plan]);
  if (!wl) return null;
  const pace = (l: { distance: number; moving_time: number }) => l.moving_time / (l.distance / 1000);
  const reps = wl.filter((x) => x.role === "work");
  const floats = wl.filter((x) => x.label === "Float");
  const avg = (xs: typeof wl) => xs.reduce((a, x) => a + x.lap.moving_time, 0) / Math.max(1, xs.reduce((a, x) => a + x.lap.distance / 1000, 0));
  const repPaces = reps.map((x) => pace(x.lap));
  const spread = repPaces.length > 1 ? Math.max(...repPaces) - Math.min(...repPaces) : 0;
  const t = reps.find((x) => x.target)?.target ?? null;
  const ft = floats.find((x) => x.target)?.target ?? null;
  const verdict = (x: (typeof wl)[number]) => {
    if (!x.target) return null;
    const p = pace(x.lap);
    return p < x.target[0] - 3 ? "fast" : p > x.target[1] + 3 ? "slow" : "on";
  };
  return (
    <section className="wl">
      <h3>Workout</h3>
      <div className="wl-sum">
        <span>
          <b className="num">{reps.length}</b> reps · avg <b className="num">{fmtPace(avg(reps))}/km</b>
          {t && <small> (target {fmtPace(t[0])}–{fmtPace(t[1])})</small>}
        </span>
        {repPaces.length > 1 && (
          <span>
            spread <b className="num">{Math.round(spread)} s/km</b> <small>{spread <= 6 ? "very even" : spread <= 12 ? "even" : "uneven"}</small>
          </span>
        )}
        {floats.length > 0 && (
          <span>
            floats avg <b className="num">{fmtPace(avg(floats))}/km</b>
            {ft && <small> (target {fmtPace(ft[0])}–{fmtPace(ft[1])})</small>}
          </span>
        )}
      </div>
      <div className="wl-table-wrap">
        <table className="table wl-table">
          <thead>
            <tr>
              <th />
              <th className="num-col">Time</th>
              <th className="num-col">Distance</th>
              <th className="num-col">Pace</th>
              <th className="num-col">Target</th>
              <th className="num-col">HR</th>
            </tr>
          </thead>
          <tbody>
            {wl.map((x, i) => {
              const v = verdict(x);
              return (
                <tr key={i} className={`wl-${x.role}${x.label === "Float" ? " wl-float" : ""}`}>
                  <td>{x.label}</td>
                  <td className="num-col">{duration(x.lap.moving_time)}</td>
                  <td className="num-col">{x.lap.distance >= 1000 ? `${(x.lap.distance / 1000).toFixed(2)} km` : `${Math.round(x.lap.distance)} m`}</td>
                  <td className={"num-col" + (v ? ` wl-${v}` : "")}>
                    <b>{fmtPace(pace(x.lap))}</b>
                  </td>
                  <td className="num-col muted">{x.target ? `${fmtPace(x.target[0])}–${fmtPace(x.target[1])}` : ""}</td>
                  <td className="num-col">{x.lap.hr ? Math.round(x.lap.hr) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** After a run Garmin moved your race predictions: say so, with the before and after. */
function PredictionMoved({ date }: { date: string }) {
  const rv = useDataVersion("health");
  const { data } = useQuery(() => predictionChange(date), [date, rv]);
  if (!data?.length) return null;
  const better = data.filter((x) => x.after < x.before).length;
  const t = (s: number) => duration(Math.round(s));
  return (
    <div className={"run-pred " + (better >= data.length / 2 ? "up" : "down")}>
      <b>{better === data.length ? "Race predictions improved" : better ? "Race predictions moved" : "Race predictions slipped"}</b>
      <span className="small">after this run (Garmin):</span>
      {data.map((x) => (
        <span key={x.name} className="run-pred-item">
          {x.name} <span className="num">{t(x.before)}</span> → <b className="num">{t(x.after)}</b>{" "}
          <em className={x.after < x.before ? "up" : "down"}>
            {x.after < x.before ? "−" : "+"}
            {t(Math.abs(x.after - x.before)).replace(/^0:/, "")}
          </em>
        </span>
      ))}
    </div>
  );
}

function RunDetail({ id, onBack, onClose }: { id: string; onBack?: () => void; onClose: () => void }) {
  const today = useToday();
  const [full, setFull] = useState<FullRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [map, setMap] = useState(false);
  const rv = useDataVersion("running");
  const { data } = useQuery(() => Promise.all([loadRuns("2024-01-01"), loadShoes(), loadPlan(), loadOverrides(), loadDetails("2024-01-01")]), [id, rv]);
  useEffect(() => {
    setFull(null);
    setErr(null);
    loadFullRun(id).then(setFull, (e) => setErr(String((e as Error)?.message ?? e).replace(/^offline:.*/, "Offline — laps and charts need a connection the first time.")));
  }, [id]);
  const run: Run | undefined = data?.[0].find((r) => r.id === id);
  const charts = useMemo(() => {
    const s = full?.streams;
    if (!s?.distance) return null;
    const x = s.distance.map((d) => d / 1000);
    return {
      pace: s.velocity ? thin(x, s.velocity.map((v) => (v > 0.8 ? 1000 / v : NaN))) : [],
      hr: s.heartrate ? thin(x, s.heartrate) : [],
      alt: s.altitude ? thin(x, s.altitude) : [],
      cad: s.cadence ? thin(x, s.cadence.map((c) => c * 2)) : [],
    };
  }, [full]);
  if (!run) return <Head title="Run" onClose={onClose} onBack={onBack} />;
  const [, shoes, { plan }, overrides, details] = data!;
  const shoe = shoes.find((s) => s.id === run.gear_id);
  const medals = medalsByRun(collectEfforts(data![0], details)).get(run.id);
  const day = forecastWeek(plan, addDays(run.date, -((parseKey(run.date).getDay() + 6) % 7)), [run], overrides).days.find((d) => d.date === run.date);
  const check = day ? checkRun(day, run, details.get(run.id) ? { ...details.get(run.id)!, laps: full?.laps.map((l) => ({ distance: l.distance, moving_time: l.moving_time, speed: l.speed, hr: l.hr })) ?? details.get(run.id)!.laps } : null) : null;
  const lapMarks = (() => {
    let acc = 0;
    return (full?.laps ?? []).slice(0, -1).map((l) => (acc += l.distance / 1000));
  })();
  return (
    <>
      <Head
        title={run.name}
        sub={`${relativeDayLabel(run.date, today)} · ${run.start_local.slice(11, 16)}${shoe ? ` · ${shoe.name}` : ""}${full?.device ? ` · ${full.device}` : ""}`}
        onBack={onBack}
        onClose={onClose}
        right={
          <>
            <button className="btn" onClick={() => setEdit(true)}>
              Edit
            </button>
            <button className="btn" onClick={() => openSource(run.id)}>
              {run.id.startsWith("g") ? "Garmin ↗" : "Strava ↗"}
            </button>
          </>
        }
      />
      {edit && <RunReview run={run} onClose={() => setEdit(false)} />}
      {map && run.polyline && <RunMap polyline={run.polyline} title={run.name} onClose={() => setMap(false)} />}
      <RunNotes id={run.id} />
      <PredictionMoved date={run.date} />
      <RunFocus run={run} label="Training focus" />
      {details.get(run.id)?.photo && <img className="run-photo" src={details.get(run.id)!.photo!} alt="Photo from the run" referrerPolicy="no-referrer" />}
      <div className="run-detail-top">
        <button type="button" className="run-detail-map" onClick={() => run.polyline && setMap(true)} aria-label="Open the map" disabled={!run.polyline}>
          <RunMapThumb polyline={run.polyline} height={170} />
          {run.polyline && <span className="rr-map-hint">Tap for the map</span>}
        </button>
        <div className="run-stats">
          <Stat label="Distance" value={`${km(run.distance).toFixed(2)} km`} />
          <Stat label="Moving time" value={duration(run.moving_time)} note={run.elapsed_time > run.moving_time + 60 ? `${duration(run.elapsed_time)} elapsed` : undefined} />
          <Stat label="Pace" value={`${pace(run.distance, run.moving_time)}/km`} />
          <Stat label="Heart rate" value={run.avg_hr ? `${Math.round(run.avg_hr)} bpm` : "–"} note={run.max_hr ? `max ${Math.round(run.max_hr)}` : undefined} />
          <Stat label="Climb" value={`${Math.round(run.elevation || 0)} m`} />
          {full?.calories ? <Stat label="Calories" value={String(Math.round(full.calories))} /> : null}
        </div>
      </div>
      {medals && (
        <div className="run-medals">
          <MedalBadges medals={medals} max={8} full />
        </div>
      )}
      {day && day.text && (
        <div className="run-plan-line small">
          <span className="label">Planned</span> {day.text || "–"}
          {day.pace && ` · ${day.pace}${/\d:\d\d$/.test(day.pace) ? "/km" : ""}`}
          {check && (
            <>
              {" · "}
              <b className={check.verdict === "on-point" ? "tone-accent" : check.verdict.startsWith("slightly") ? "tone-warn" : "tone-danger"}>{verdictLabel(check)}</b> — {check.measured}{" "}
              {fmtVal(check, check.actual)}{check.inRange != null ? `, ${Math.round(check.inRange * 100)}% in range` : ""}
            </>
          )}
        </div>
      )}
      {full?.description && <p className="run-desc">{full.description}</p>}
      <ErrorNote error={err} />
      {!full && !err && <p className="muted small">Loading laps and charts…</p>}
      {full && <WorkoutLapsView laps={full.laps} planned={day?.text} plan={plan} />}
      {charts && (
        <div className="run-charts">
          {charts.pace.length > 1 && <XYChart label="Pace" points={charts.pace} invert format={(v) => fmtPace(v)} marks={lapMarks} />}
          {charts.hr.length > 1 && (
            <XYChart
              label="Heart rate"
              points={charts.hr}
              className="s-acute"
              height={130}
              fill="#e8344e"
              format={(v) => `${Math.round(v)}`}
              marks={lapMarks}
              // Like Strava: the scale starts well below your lowest heart rate, in steps of 20 (or 10 for a narrow range).
              range={(lo, hi) => {
                const step = hi - lo > 50 ? 20 : 10;
                const bottom = Math.max(40, Math.floor((lo - Math.max(25, (hi - lo) * 0.8)) / step) * step);
                return { lo: bottom, hi: Math.ceil((hi + 3) / step) * step, step };
              }}
            />
          )}
          {charts.alt.length > 1 && <XYChart label="Elevation" points={charts.alt} className="s-chronic" area height={80} format={(v) => `${Math.round(v)} m`} />}
          {charts.cad.length > 1 && <XYChart label="Cadence" points={charts.cad} className="s-eff" height={80} format={(v) => `${Math.round(v)}`} />}
        </div>
      )}
      {full && full.laps.length > 1 && (
        <>
          <h3>Laps</h3>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th className="num-col">Distance</th>
                <th className="num-col">Time</th>
                <th className="num-col">Pace</th>
                <th className="num-col">Avg HR</th>
                <th className="num-col">Max HR</th>
                <th className="num-col">Cadence</th>
                <th className="num-col">Climb</th>
              </tr>
            </thead>
            <tbody>
              {full.laps.map((l, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="num-col">{l.distance >= 1000 ? `${(l.distance / 1000).toFixed(2)} km` : `${Math.round(l.distance)} m`}</td>
                  <td className="num-col">{duration(l.moving_time)}</td>
                  <td className="num-col">{paceOf(l.speed)}</td>
                  <td className="num-col">{l.hr ? Math.round(l.hr) : "–"}</td>
                  <td className="num-col">{l.max_hr ? Math.round(l.max_hr) : "–"}</td>
                  <td className="num-col">{l.cadence ? Math.round(l.cadence) : "–"}</td>
                  <td className="num-col">{l.elev != null ? `${Math.round(l.elev)} m` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(full?.splits.length ?? 0) > 1 && (
        <>
          <h3>Kilometre splits</h3>
          <div className="split-bars">
            {full!.splits.map((s, i) => {
              const fastest = Math.max(...full!.splits.map((x) => x.speed));
              const slowest = Math.min(...full!.splits.map((x) => x.speed));
              const w = slowest === fastest ? 100 : 35 + ((s.speed - slowest) / (fastest - slowest)) * 65;
              return (
                <div key={i} className="split-row">
                  <span className="muted num">{i + 1}</span>
                  <span className="split-bar">
                    <span style={{ width: `${w}%` }} />
                  </span>
                  <span className="num">{pace(s.distance, s.moving_time)}</span>
                  <span className="num muted">{s.gap ? `GAP ${paceOf(s.gap)}` : ""}</span>
                  <span className="num muted">{s.hr ? `${Math.round(s.hr)} bpm` : ""}</span>
                  <span className="num muted">{s.elev != null ? `${s.elev > 0 ? "+" : ""}${Math.round(s.elev)} m` : ""}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

/** What you wrote about the run: feel, effort, shoes, notes. */
function RunNotes({ id }: { id: string }) {
  const rv = useDataVersion("running");
  const { data } = useQuery(() => Promise.all([loadAllRunMeta(), loadMyShoes()]), [id, rv]);
  const m = data?.[0].get(id);
  if (!m || (!m.notes && !m.feel && !m.rpe && !m.shoe)) return null;
  const f = FEELS.find((x) => x.id === m.feel);
  const shoe = data![1].find((s) => s.id === m.shoe);
  return (
    <div className="run-notes">
      <div className="inline">
        {f && <span className="pill">{f.face} {f.label}</span>}
        {m.rpe ? <span className="pill">Effort {m.rpe}/10</span> : null}
        {shoe && <span className="pill">👟 {shoe.name}</span>}
      </div>
      {m.notes && <p>{m.notes}</p>}
    </div>
  );
}
