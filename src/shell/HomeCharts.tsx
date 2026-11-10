import { useMemo, useState, type ReactNode } from "react";
import { addDays, parseKey } from "../core/time";
import type { Fitness } from "../modules/running/fitness";
import { mondayOf, type Plan } from "../modules/running/plan";
import { pacesFor, type Paces } from "../modules/running/planBuilder";
import { openRun, openWeek } from "../modules/running/RunView";
import { duration, raceHistory } from "../modules/running/stats";
import type { Run, RunDetail } from "../modules/running/strava";
import { predictTime, vdot } from "../modules/running/vo2";
import { niceTicks, useBox } from "./charts";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;

// ---- Are you building? ---------------------------------------------------------------

const BANDS = [
  { key: "easy", label: "Easy / zone 2", colour: "#2e9e5b" },
  { key: "steady", label: "Steady (marathon)", colour: "#4f8bd9" },
  { key: "threshold", label: "Threshold", colour: "#e8a23d" },
  { key: "speed", label: "Speed (5K and faster)", colour: "#e8504e" },
] as const;

/** Which band a pace (s/km) is in: easy, steady, threshold or speed. */
function band(p: number, pc: Paces): number {
  if (p > pc.mp + 15) return 0;
  if (p > pc.threshold + 6) return 1;
  if (p > pc.fivek + 4) return 2;
  return 3;
}

export type BuildStatus = "productive" | "peaking" | "maintaining" | "recovery" | "unproductive" | "detraining" | "overreaching";
export const STATUS: Record<BuildStatus, { label: string; text: string }> = {
  productive: { label: "Productive", text: "Your fitness is rising with your training." },
  peaking: { label: "Peaking", text: "Fitness up while the load comes down: fresh, the place to be before a race." },
  maintaining: { label: "Maintaining", text: "Enough training to hold your fitness, not yet to raise it." },
  recovery: { label: "Recovery", text: "Light weeks: fitness is holding while you recover." },
  unproductive: { label: "Unproductive", text: "The training is there but fitness is slipping: more sleep and recovery, and keep easy runs easy." },
  detraining: { label: "Detraining", text: "Too little load to hold your fitness: build back gradually." },
  overreaching: { label: "Overreaching", text: "Load is climbing faster than you can adapt: take a few easy days." },
};

/** Like Garmin's training status: VO2 max over 4 weeks against how hard you've trained lately. */
export function buildStatus(dVo2: number | null, ratio: number | null): BuildStatus {
  if (ratio != null && ratio > 1.5) return "overreaching";
  if (dVo2 == null) return ratio != null && ratio < 0.8 ? "recovery" : "maintaining";
  if (dVo2 >= 0.3) return ratio != null && ratio < 0.8 ? "peaking" : "productive";
  if (dVo2 <= -0.3) return ratio != null && ratio < 0.8 ? "detraining" : "unproductive";
  return ratio != null && ratio < 0.8 ? "recovery" : "maintaining";
}

interface WeekBuild {
  monday: string;
  km: number[]; // per band
  total: number;
  vo2: number | null;
}

export function weekBuilds(f: Fitness, runs: Run[], details: Map<string, RunDetail>, today: string, count = 16): WeekBuild[] {
  const vd = f.predictionBasis?.vdot ?? f.current;
  const pc = vd ? pacesFor(vd) : null;
  const weeks: WeekBuild[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = addDays(mondayOf(today), -7 * i);
    const km = [0, 0, 0, 0];
    for (const r of runs) {
      if (r.date < m || r.date > addDays(m, 6)) continue;
      const sp = details.get(r.id)?.splits?.filter((s) => s.distance > 100 && s.moving_time > 0) ?? [];
      if (pc && sp.length) for (const s of sp) km[band(s.moving_time / (s.distance / 1000), pc)] += s.distance / 1000;
      else if (pc && r.distance > 0) km[band(r.moving_time / (r.distance / 1000), pc)] += r.distance / 1000;
      else km[0] += r.distance / 1000;
    }
    const w = f.weekly.find((x) => x.week === m);
    weeks.push({ monday: m, km, total: km.reduce((a, b) => a + b, 0), vo2: w?.smooth != null ? w.smooth + f.shift : null });
  }
  return weeks;
}

/** Weekly km by intensity, VO2 max over it, and what it adds up to: productive, maintaining, … */
export function BuildingCard({ f, runs, details, today }: { f: Fitness; runs: Run[]; details: Map<string, RunDetail>; today: string }) {
  const weeks = useMemo(() => weekBuilds(f, runs, details, today), [f, runs, details, today]);
  const [ref, box] = useBox(true);
  const [hover, setHover] = useState<number | null>(null);
  const vo2s = weeks.map((w) => w.vo2).filter((v): v is number => v != null);
  const last = [...weeks].reverse().find((w) => w.vo2 != null);
  const lastI = last ? weeks.indexOf(last) : -1;
  const before = lastI >= 4 ? weeks.slice(0, lastI - 3).reverse().find((w) => w.vo2 != null) : null;
  const dVo2 = last?.vo2 != null && before?.vo2 != null ? last.vo2 - before.vo2 : null;
  const status = buildStatus(dVo2, f.load.ratio);
  const recent = weeks.slice(-4);
  const prev = weeks.slice(-8, -4);
  const avg = (ws: WeekBuild[]) => ws.reduce((a, w) => a + w.total, 0) / Math.max(1, ws.length);
  const sum = (ws: WeekBuild[], b: number) => ws.reduce((a, w) => a + w.km[b], 0);
  const recentTotal = recent.reduce((a, w) => a + w.total, 0);
  const easyShare = recentTotal ? sum(recent, 0) / recentTotal : null;

  const W = box.w || 800;
  // As tall as its box (the home page fills the screen).
  const H = Math.max(110, (box.h || 200) - 22);
  const pad = { top: 12, bottom: 20, left: 34, right: 40 };
  const kmMax = Math.max(10, ...weeks.map((w) => w.total)) * 1.08;
  const vLo = vo2s.length ? Math.floor(Math.min(...vo2s) - 1) : 40;
  const vHi = vo2s.length ? Math.ceil(Math.max(...vo2s) + 1) : 60;
  const bw = (W - pad.left - pad.right) / weeks.length;
  const yKm = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - v / kmMax);
  const yV = (v: number) => pad.top + (H - pad.top - pad.bottom) * (1 - (v - vLo) / Math.max(1, vHi - vLo));
  const line = weeks
    .map((w, i) => (w.vo2 != null ? `${pad.left + i * bw + bw / 2},${yV(w.vo2)}` : null))
    .filter(Boolean)
    .join(" ");
  const h = hover != null ? weeks[hover] : null;

  return (
    <section className="home-card home-build">
      <header>
        <h3>Are you building?</h3>
        <span className={`build-pill b-${status}`}>{STATUS[status].label}</span>
        <span className="muted small">{STATUS[status].text}</span>
      </header>
      <div className="build-facts">
        <span>
          VO2 max <b className="num">{last?.vo2 != null ? last.vo2.toFixed(1) : "–"}</b>
          {dVo2 != null && <small className={dVo2 >= 0.3 ? "up" : dVo2 <= -0.3 ? "down" : ""}> {dVo2 >= 0 ? "+" : "−"}{Math.abs(dVo2).toFixed(1)} in 4 weeks</small>}
        </span>
        <span>
          <b className="num">{Math.round(avg(recent))}</b> km/week <small>last 4 (before: {Math.round(avg(prev))})</small>
        </span>
        <span>
          <b className="num">{easyShare != null ? Math.round(easyShare * 100) : "–"}%</b> easy <small>(aim for ~80%)</small>
        </span>
        <span>
          <b className="num">{Math.round(sum(recent, 2) + sum(recent, 3))}</b> km threshold and faster <small>last 4 weeks</small>
        </span>
        <span>
          Load <b className="num">{f.load.ratio != null ? f.load.ratio.toFixed(2) : "–"}</b> <small>acute : chronic</small>
        </span>
      </div>
      <div className="chart build-chart" ref={ref} onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Weekly kilometres by intensity with VO2 max">
          {niceTicks(0, kmMax).map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={yKm(t)} y2={yKm(t)} className="chart-grid" />
              <text x={pad.left - 6} y={yKm(t) + 3.5} textAnchor="end" className="chart-label">
                {t}
              </text>
            </g>
          ))}
          <text x={pad.left - 6} y={pad.top - 2} textAnchor="end" className="chart-label">
            km
          </text>
          {vo2s.length > 0 &&
            niceTicks(vLo, vHi).map((t) => (
              <text key={t} x={W - pad.right + 6} y={yV(t) + 3.5} className="chart-label build-vlabel">
                {t}
              </text>
            ))}
          {weeks.map((w, i) => {
            let acc = 0;
            const x = pad.left + i * bw;
            return (
              <g key={w.monday} onMouseEnter={() => setHover(i)} onClick={() => openWeek(w.monday)} style={{ cursor: "pointer" }}>
                <rect x={x} y={pad.top} width={bw} height={H - pad.top - pad.bottom} fill="transparent" />
                {w.km.map((k, b) => {
                  if (k <= 0) return null;
                  const y0 = yKm(acc);
                  acc += k;
                  const y1 = yKm(acc);
                  return <rect key={b} x={x + bw * 0.16} y={y1} width={bw * 0.68} height={Math.max(0, y0 - y1)} fill={BANDS[b].colour} opacity={hover === i ? 1 : 0.85} />;
                })}
                {(parseKey(w.monday).getDate() <= 7 || i === 0) && (
                  <text x={x + bw / 2} y={H - 5} textAnchor="middle" className="chart-label">
                    {MON[parseKey(w.monday).getMonth()]}
                  </text>
                )}
              </g>
            );
          })}
          {line && <polyline points={line} className="build-vo2" />}
          {weeks.map((w, i) => (w.vo2 != null ? <circle key={i} cx={pad.left + i * bw + bw / 2} cy={yV(w.vo2)} r={hover === i ? 4 : 2.5} className="build-vo2-dot" /> : null))}
        </svg>
        <div className="chart-readout small">
          {h
            ? `Week of ${fmt(h.monday)}: ${h.total.toFixed(0)} km (${BANDS.map((b, i) => `${b.label.split(" ")[0].toLowerCase()} ${h.km[i].toFixed(0)}`).join(", ")})${h.vo2 != null ? ` · VO2 max ${h.vo2.toFixed(1)}` : ""}`
            : " "}
        </div>
      </div>
      <div className="build-legend">
        {BANDS.map((b) => (
          <span key={b.key}>
            <i style={{ background: b.colour }} />
            {b.label}
          </span>
        ))}
        <span>
          <i className="build-legend-line" />
          VO2 max (right axis)
        </span>
      </div>
    </section>
  );
}

// ---- Your races against your best -------------------------------------------------------

const BUCKETS = [
  { name: "5K", km: 5, lo: 4.85, hi: 5.2 },
  { name: "10K", km: 10, lo: 9.8, hi: 10.35 },
  { name: "Half", km: 21.0975, lo: 20.8, hi: 21.5 },
  { name: "Marathon", km: 42.195, lo: 41.8, hi: 42.9 },
];

/**
 * Each distance's best race (2 years) as a VO2 max (VDOT), against your strongest one: which races are
 * as good as your best, and which have time to find.
 */
export function RaceEquivalence({ f, runs, plan, today, news }: { f: Fitness; runs: Run[]; plan: Plan; today: string; news?: ReactNode }) {
  const rows = useMemo(() => {
    const since = addDays(today, -730);
    const races = raceHistory(runs, plan).filter((r) => r.date >= since);
    return BUCKETS.map((b) => {
      const best = races.filter((r) => r.km >= b.lo && r.km <= b.hi).sort((a, c) => a.time - c.time)[0] ?? null;
      return { ...b, race: best, v: best ? vdot(b.km * 1000, best.time) : null };
    });
  }, [runs, plan, today]);
  const vs = rows.map((r) => r.v).filter((v): v is number => v != null);
  if (!vs.length) return null;
  const top = Math.max(...vs);
  const strongest = rows.find((r) => r.v === top)!;
  const now = f.predictionBasis?.vdot ?? f.current ?? null;
  const lo = Math.min(...vs, now ?? top) - 2;
  const scale = (v: number) => Math.max(0.03, (v - lo) / Math.max(1, top + 1 - lo));
  return (
    <section className="home-card home-equiv">
      <header>
        <h3>Race times</h3>
        <span className="muted small">now ({f.predictions[0]?.source === "garmin" ? "Garmin" : "your runs"}) · best race (2 years) · equivalent of your {strongest.name}</span>
      </header>
      {news}
      <table className="home-table equiv-table">
        <thead>
          <tr>
            <th />
            <th className="r">Now</th>
            <th>Best race</th>
            <th>VDOT</th>
            <th className="r">Equiv.</th>
            <th className="r">To find</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const eq = predictTime(r.km * 1000, top);
            const gap = r.race ? r.race.time - eq : null;
            return (
              <tr key={r.name} className={r.race ? "home-click" : ""} onClick={r.race ? () => openRun(r.race!.id) : undefined}>
                <td>
                  <b>{r.name}</b>
                </td>
                <td className="r num nowrap">
                  {(() => {
                    const p = f.predictions.find((x) => Math.abs(x.distance / 1000 - r.km) < 0.6);
                    if (!p?.seconds) return "–";
                    const ch = p.monthAgoSeconds != null ? p.seconds - p.monthAgoSeconds : null;
                    return (
                      <>
                        <b>{duration(p.seconds)}</b>
                        {ch != null && Math.abs(ch) >= 1 && <small className={ch < 0 ? "up" : "down"}> {ch < 0 ? "−" : "+"}{duration(Math.abs(ch)).replace(/^0:/, "")}</small>}
                      </>
                    );
                  })()}
                </td>
                <td className="nowrap">
                  {r.race ? (
                    <>
                      <span className="num">{duration(r.race.time)}</span> <small className="muted">{MON[parseKey(r.race.date).getMonth()]} {r.race.date.slice(2, 4)}</small>
                    </>
                  ) : (
                    <span className="muted">no race</span>
                  )}
                </td>
                <td className="equiv-bar-cell">
                  {r.v != null && (
                    <span className="equiv-bar">
                      <i style={{ width: `${scale(r.v) * 100}%` }} className={r.v >= top - 0.3 ? "best" : r.v >= top - 1.5 ? "near" : "far"} />
                      <b className="num">{r.v.toFixed(1)}</b>
                    </span>
                  )}
                </td>
                <td className="r num">{duration(eq)}</td>
                <td className={"r num " + (gap == null ? "muted" : gap <= 5 ? "up" : gap / eq > 0.03 ? "down" : "")}>{gap == null ? "–" : gap <= 5 ? "★ your best" : `−${duration(gap)}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small home-sum">
        Strongest: <b>{strongest.name}</b> (VDOT {top.toFixed(1)}).
        {now != null ? ` Your fitness now: VDOT ${now.toFixed(1)}${now > top + 0.3 ? ", above your best race: a PB is in your legs" : now < top - 1 ? ", below your best race" : ", about your best race"}.` : ""}{" "}
        {(() => {
          const soft = rows.filter((r) => r.v != null && r.v < top - 1.5).map((r) => r.name);
          return soft.length ? `Most to find: ${soft.join(", ")}.` : "";
        })()}
      </p>
    </section>
  );
}
