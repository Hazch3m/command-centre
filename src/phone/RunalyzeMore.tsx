import { useState, type ReactNode } from "react";
import { parseKey, useToday } from "../core/time";
import { marathonShape, useFitness } from "../modules/running/fitness";
import { pacesFor } from "../modules/running/planBuilder";
import { openRun } from "../modules/running/RunView";
import { km } from "../modules/running/stats";
import { useRunningData } from "../modules/running/useRunning";
import { trimp } from "../modules/running/vo2";
import { Section } from "./common";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** Click-to-read explanations, so the numbers say what they are. */
export function Explain({ children, label = "What is this?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={"xp" + (open ? " open" : "")}>
      <button type="button" className="xp-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <i aria-hidden="true">i</i>
        {open ? "Hide" : label}
      </button>
      {open && <div className="xp-body">{children}</div>}
    </div>
  );
}

/**
 * More from Runalyze: marathon shape, training paces from your VO2 max, and each run's
 * effective VO2 max and training load.
 */
export function RunalyzeMore() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan);
  if (!f?.current) return null;
  const shape = marathonShape(runs, today, f.current);
  const p = pacesFor(f.current);
  const est = new Map(f.estimates.map((e) => [e.id, e]));
  const recent = [...runs].sort((a, b) => (a.start_local < b.start_local ? 1 : -1)).slice(0, 8);
  const pct = (x: number) => Math.round(Math.min(1.5, x) * 100);
  const shapeTone = shape.total >= 0.9 ? "good" : shape.total >= 0.7 ? "ok" : "low";
  const rows: [string, string, string][] = [
    ["Recovery", `${mmss(p.recovery[1])} – ${mmss(p.recovery[0])}`, "Days after hard sessions"],
    ["Easy", `${mmss(p.easy[1])} – ${mmss(p.easy[0])}`, "Most of your running"],
    ["Long run", `${mmss(p.long[1])} – ${mmss(p.long[0])}`, "Steady, conversational"],
    ["Marathon", mmss(p.mp), "Race pace for 42 km"],
    ["Half", mmss(p.hmp), "Race pace for 21 km"],
    ["Threshold", mmss(p.threshold), "About an hour's effort; tempo"],
    ["10K", mmss(p.tenk), "Race pace for 10 km"],
    ["Interval", mmss(p.interval), "3–5 min reps; VO2 max"],
  ];
  return (
    <>
      <Section title="Marathon shape" className="p-padded">
        <div className="rz-shape">
          <span className={`rz-big ${shapeTone}`}>
            <b className="num">{pct(shape.total)}</b>
            <small>%</small>
          </span>
          <span className="rz-parts">
            <span>
              <small>Weekly km</small>
              <span className="rz-bar">
                <i style={{ width: `${Math.min(100, pct(shape.weekly))}%` }} />
              </span>
              <em className="num">
                {Math.round(shape.kmPerWeek)} of {Math.round(shape.targetKm)} km
              </em>
            </span>
            <span>
              <small>Long runs</small>
              <span className="rz-bar">
                <i style={{ width: `${Math.min(100, pct(shape.long))}%` }} />
              </span>
              <em className="num">target {Math.round(shape.targetLong)} km</em>
            </span>
          </span>
        </div>
        <Explain>
          Runalyze's marathon shape: is the training volume there for a marathon at your fitness? Two thirds comes from your weekly kilometres over the last six months (recent weeks
          count more), a third from long runs over 13 km in the last 10 weeks. 100% means the volume matches your VO2 max; below that, your marathon prediction is slowed down.
          Shorter races need much less of it.
        </Explain>
      </Section>

      <Section title="Your training paces" className="p-padded">
        <div className="rz-paces">
          {rows.map(([name, pace, what]) => (
            <span key={name} className="rz-pace">
              <b>{name}</b>
              <span className="num">{pace} /km</span>
              <small>{what}</small>
            </span>
          ))}
        </div>
        <Explain>From your current VO2 max ({(f.current + f.shift).toFixed(1)}), the way Jack Daniels' VDOT tables work. They move as your fitness changes.</Explain>
      </Section>

      <Section title="Recent runs · effective VO2 max" className="p-padded">
        <div className="rz-runs">
          {recent.map((r) => {
            const e = est.get(r.id);
            const load = trimp(r.moving_time, r.avg_hr ?? null, f.config);
            return (
              <button key={r.id} type="button" className="rz-run" onClick={() => openRun(r.id)}>
                <span className="rz-run-main">
                  <b>{r.name}</b>
                  <small>
                    {parseKey(r.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} · {km(r.distance).toFixed(1)} km
                  </small>
                </span>
                <span className="rz-run-vals">
                  <span>
                    <small>VO2</small>
                    <b className="num">{e ? (e.vo2 + f.shift).toFixed(1) : "–"}</b>
                  </span>
                  <span>
                    <small>TRIMP</small>
                    <b className="num">{r.avg_hr ? Math.round(load) : "–"}</b>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <Explain>
          Effective VO2 max is what a run says about your fitness, from its pace against its heart rate (Runalyze's method): an easy run done at a low heart rate scores as high
          as a hard one. TRIMP is the run's training load: time weighted by how hard your heart worked. Both need heart rate.
        </Explain>
      </Section>
    </>
  );
}
