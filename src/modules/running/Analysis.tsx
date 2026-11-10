import { useMemo, useState, type ReactNode } from "react";
import { db } from "../../core/db";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { latest as latestHealth, loadHealth } from "../health/data";
import { shapeFactor, useFitness, type Fitness } from "./fitness";
import { loadGarminZones, loadZoneSettings, resolveZones, zoneOf, type Zones } from "./hrZones";
import { mondayOf } from "./plan";
import { pacesFor, type Paces } from "./planBuilder";
import { dailyLoad, loadSeries, monotony } from "./runalyze";
import { openRun } from "./RunView";
import { duration, pace } from "./stats";
import { loadDetails, type Run, type RunDetail } from "./strava";
import { useRunningData } from "./useRunning";
import { predictTime, trimp, type Vo2Config } from "./vo2";

/**
 * Runalyze-style analysis for a big screen: the week run by run (pace and heart-rate zones,
 * effective VO2 max with its arrow, TRIMP, running dynamics), month and week summaries, and a
 * side panel with the calculations, prognosis, training paces and health.
 */
interface Extra {
  id: string;
  cadence: number | null;
  gct: number | null;
  vratio: number | null;
  vosc: number | null;
  stride: number | null;
  te_aer: number | null;
  te_ana: number | null;
  power: number | null;
  vo2: number | null;
}

const ZONE_COLOURS = ["#2e9e5b", "#7cc35a", "#e8d44d", "#f2913d", "#e8344e"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const n1 = (x: number) => x.toFixed(1);
const fmtD = (d: string) => `${parseKey(d).getDate()}.${String(parseKey(d).getMonth() + 1).padStart(2, "0")}`;

/** Pace zone of a km (s/km): easy, steady, threshold, interval, faster. */
function paceZone(s: number, p: Paces): number {
  if (s > p.mp + 15) return 1;
  if (s > p.threshold + 6) return 2;
  if (s > p.fivek + 4) return 3;
  if (s > p.interval - 6) return 4;
  return 5;
}

type Shares = number[]; // seconds in zones 1–5
const zeros = () => [0, 0, 0, 0, 0];
const add = (a: Shares, b: Shares) => a.map((x, i) => x + b[i]);

function Bar({ shares }: { shares: Shares }) {
  const t = shares.reduce((a, b) => a + b, 0);
  if (!t) return <span className="ana-bar empty" />;
  return (
    <span className="ana-bar" title={shares.map((x, i) => `Z${i + 1} ${Math.round((x / t) * 100)}%`).join(" · ")}>
      {shares.map((x, i) => (x > 0 ? <i key={i} style={{ flexGrow: x, background: ZONE_COLOURS[i] }} /> : null))}
    </span>
  );
}

/** Runalyze's arrow: a run's VO2 max against your shape at the time. */
function arrowFor(diff: number | null) {
  if (diff == null) return null;
  const [a, cls] = diff >= 1.5 ? ["↑", "up"] : diff >= 0.5 ? ["↗", "up"] : diff > -0.5 ? ["→", "flat"] : diff > -1.5 ? ["↘", "down"] : ["↓", "down"];
  return (
    <span className={`ana-arrow ${cls}`} title={`${diff >= 0 ? "+" : ""}${diff.toFixed(1)} vs your shape then`}>
      {a}
    </span>
  );
}

interface Row {
  run: Run;
  type: string;
  paceZ: Shares;
  hrZ: Shares;
  trimp: number;
  vo2: number | null;
  vo2Diff: number | null;
  extra: Extra | null;
}

function runType(r: Run, d: RunDetail | undefined, p: Paces | null): string {
  if (r.workout_type === 1 || /race|parkrun|\b(5|10)k\b.*(race)|marathon/i.test(r.name)) return "RC";
  if (r.distance >= 18000 || r.moving_time >= 90 * 60) return "LR";
  if (p && d?.splits?.length) {
    const fast = d.splits.filter((s) => s.speed > 0 && 1000 / s.speed < p.threshold + 6).length;
    if (fast / d.splits.length > 0.15) return fast / d.splits.length > 0.5 ? "TR" : "IT";
  }
  return /recovery/i.test(r.name) ? "RR" : "ER";
}
const TYPE_TEXT: Record<string, string> = { RC: "Race", LR: "Long run", IT: "Intervals", TR: "Tempo", ER: "Easy run", RR: "Recovery run" };

interface Sum {
  n: number;
  dist: number;
  time: number;
  hrTime: number;
  hrSum: number;
  elev: number;
  trimp: number;
  paceZ: Shares;
  hrZ: Shares;
  cad: [number, number];
  gct: [number, number];
  vr: [number, number];
  vo2: [number, number];
}
const emptySum = (): Sum => ({ n: 0, dist: 0, time: 0, hrTime: 0, hrSum: 0, elev: 0, trimp: 0, paceZ: zeros(), hrZ: zeros(), cad: [0, 0], gct: [0, 0], vr: [0, 0], vo2: [0, 0] });
function addRow(s: Sum, r: Row): Sum {
  const t = r.run.moving_time;
  const w = (pair: [number, number], v: number | null | undefined): [number, number] => (v ? [pair[0] + v * t, pair[1] + t] : pair);
  return {
    n: s.n + 1,
    dist: s.dist + r.run.distance,
    time: s.time + t,
    hrTime: s.hrTime + (r.run.avg_hr ? t : 0),
    hrSum: s.hrSum + (r.run.avg_hr ? r.run.avg_hr * t : 0),
    elev: s.elev + (r.run.elevation ?? 0),
    trimp: s.trimp + r.trimp,
    paceZ: add(s.paceZ, r.paceZ),
    hrZ: add(s.hrZ, r.hrZ),
    cad: w(s.cad, r.extra?.cadence),
    gct: w(s.gct, r.extra?.gct),
    vr: w(s.vr, r.extra?.vratio),
    vo2: w(s.vo2, r.vo2),
  };
}
const avg = (p: [number, number]) => (p[1] ? p[0] / p[1] : null);

export function Analysis() {
  const today = useToday();
  const { plan, runs = [] } = useRunningData();
  const f = useFitness(plan ?? undefined);
  const rv = useDataVersion("running");
  const hv = useDataVersion("health");
  const q = useQuery(
    () => Promise.all([loadDetails(addDays(today, -420)), db.select<Extra>("SELECT * FROM run_extra").catch(() => [] as Extra[]), loadZoneSettings(), loadGarminZones()]),
    [rv, today],
  ).data;
  const health = useQuery(() => loadHealth(21), [hv]).data ?? [];
  const [monday, setMonday] = useState(() => mondayOf(today));

  const model = useMemo(() => {
    if (!f || !q) return null;
    const [details, extras, zs, gz] = q;
    const cfg = f.config as Vo2Config;
    const zones: Zones = resolveZones(zs, gz, cfg);
    const vd = f.predictionBasis?.vdot ?? f.current ?? null;
    const paces = vd ? pacesFor(vd) : null;
    const ex = new Map(extras.map((e) => [e.id, e]));
    const est = new Map(f.estimates.map((e) => [e.id, e.vo2]));
    const shapeAt = (date: string) => [...f.weekly].reverse().find((w) => w.week <= mondayOf(date) && w.smooth != null)?.smooth ?? null;
    const rows = new Map<string, Row>();
    for (const r of runs) {
      const d = details.get(r.id);
      const paceZ = zeros();
      const hrZ = zeros();
      const splits = d?.splits?.filter((s) => s.moving_time > 0 && s.distance > 100) ?? [];
      if (splits.length) {
        for (const s of splits) {
          if (paces && s.speed > 0) paceZ[paceZone(1000 / s.speed, paces) - 1] += s.moving_time;
          if (s.hr) hrZ[zoneOf(s.hr, zones) - 1] += s.moving_time;
        }
      } else {
        if (paces && r.distance > 0) paceZ[paceZone(r.moving_time / (r.distance / 1000), paces) - 1] += r.moving_time;
        if (r.avg_hr) hrZ[zoneOf(r.avg_hr, zones) - 1] += r.moving_time;
      }
      const vo2 = est.get(r.id) ?? null;
      const shape = shapeAt(r.date);
      rows.set(r.id, { run: r, type: runType(r, d, paces), paceZ, hrZ, trimp: trimp(r.moving_time, r.avg_hr ?? null, cfg), vo2, vo2Diff: vo2 != null && shape != null ? vo2 - shape : null, extra: ex.get(r.id) ?? null });
    }
    const daily = dailyLoad(runs, cfg);
    const series = loadSeries(daily, addDays(today, -365), today);
    return { rows, paces, vd, zones, series, mono: monotony(daily, today) };
  }, [f, q, runs, today]);

  if (!f || !model) return <div className="ana-wait">Working out your analysis…</div>;
  const rowsIn = (from: string, to: string) => [...model.rows.values()].filter((r) => r.run.date >= from && r.run.date <= to).sort((a, b) => a.run.start_local.localeCompare(b.run.start_local));
  const show = (v: number | null) => (v == null ? "–" : (v + f.shift).toFixed(1));

  // The week.
  const weekRows = rowsIn(monday, addDays(monday, 6));
  const weekSum = weekRows.reduce(addRow, emptySum());

  // Months (last six) and weeks (last ten).
  const months: { key: string; label: string; sum: Sum }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = parseKey(today);
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const from = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-01`;
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 0);
    const to = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}`;
    months.push({ key: from, label: MONTHS[m.getMonth()], sum: rowsIn(from, to).reduce(addRow, emptySum()) });
  }
  const weeks: { key: string; label: string; sum: Sum }[] = [];
  for (let i = 0; i < 11; i++) {
    const m = addDays(mondayOf(today), -7 * i);
    weeks.push({ key: m, label: `${fmtD(m)} – ${fmtD(addDays(m, 6))}`, sum: rowsIn(m, addDays(m, 6)).reduce(addRow, emptySum()) });
  }

  const now = model.series[model.series.length - 1];
  const maxAtl = Math.max(1, ...model.series.map((p) => p.atl));
  const maxCtl = Math.max(1, ...model.series.map((p) => p.ctl));
  const monthKm = months[0].sum.dist / 1000;
  const h = latestHealth(health);

  return (
    <div className="ana">
      <div className="ana-main">
        <div className="ana-weekbar">
          <button type="button" onClick={() => setMonday(addDays(monday, -7))} aria-label="Previous week">
            ‹
          </button>
          <b>
            {fmtD(monday)} – {fmtD(addDays(monday, 6))}
          </b>
          <button type="button" onClick={() => setMonday(addDays(monday, 7))} aria-label="Next week" disabled={monday >= mondayOf(today)}>
            ›
          </button>
          {monday !== mondayOf(today) && (
            <button type="button" className="ana-link" onClick={() => setMonday(mondayOf(today))}>
              This week
            </button>
          )}
        </div>
        <div className="ana-scroll">
          <table className="ana-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Type</th>
                <th className="r">Distance</th>
                <th className="r">Duration</th>
                <th className="r">Pace</th>
                <th>Pace zones</th>
                <th className="r">avg. HR</th>
                <th>HR zones</th>
                <th className="r">Asc.</th>
                <th className="r">Cadence</th>
                <th className="r">GC</th>
                <th className="r">Vert. ratio</th>
                <th>Title</th>
                <th className="r">TRIMP</th>
                <th className="r">VO2max</th>
                <th className="r">TE</th>
              </tr>
            </thead>
            <tbody>
              {DOW.map((dn, i) => {
                const date = addDays(monday, i);
                const rs = weekRows.filter((r) => r.run.date === date);
                if (!rs.length)
                  return (
                    <tr key={date} className={"ana-empty" + (date === today ? " today" : "")}>
                      <td>
                        {fmtD(date)} {dn}
                      </td>
                      <td colSpan={15} />
                    </tr>
                  );
                return rs.map((r, j) => (
                  <tr key={r.run.id} className={date === today ? "today" : ""}>
                    <td>{j === 0 ? `${fmtD(date)} ${dn}` : ""}</td>
                    <td title={TYPE_TEXT[r.type]}>{r.type}</td>
                    <td className="r num">{n1(r.run.distance / 1000)} km</td>
                    <td className="r num">{duration(r.run.moving_time)}</td>
                    <td className="r num">{pace(r.run.distance, r.run.moving_time)}/km</td>
                    <td>
                      <Bar shares={r.paceZ} />
                    </td>
                    <td className="r num">{r.run.avg_hr ? `${Math.round(r.run.avg_hr)} bpm` : "–"}</td>
                    <td>
                      <Bar shares={r.hrZ} />
                    </td>
                    <td className="r num">{r.run.elevation != null ? `${Math.round(r.run.elevation)} m` : "–"}</td>
                    <td className="r num">{r.extra?.cadence ? `${Math.round(r.extra.cadence)} spm` : "–"}</td>
                    <td className="r num">{r.extra?.gct ? `${Math.round(r.extra.gct)} ms` : "–"}</td>
                    <td className="r num">{r.extra?.vratio ? `${n1(r.extra.vratio)} %` : "–"}</td>
                    <td className="ana-title">
                      <button type="button" className="ana-link" onClick={() => openRun(r.run.id)}>
                        {r.run.name}
                      </button>
                    </td>
                    <td className="r num ana-trimp">{Math.round(r.trimp)}</td>
                    <td className="r num">
                      {show(r.vo2)} {arrowFor(r.vo2Diff)}
                    </td>
                    <td className="r num">{r.extra?.te_aer ? n1(r.extra.te_aer) : "–"}</td>
                  </tr>
                ));
              })}
              <tr className="ana-total">
                <td colSpan={2}>
                  {weekSum.n}× running
                </td>
                <SumCells s={weekSum} />
                <td />
                <td className="r num ana-trimp">{Math.round(weekSum.trimp)}</td>
                <td className="r num">{show(avg(weekSum.vo2))}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="ana-h">Months</h3>
        <SummaryTable rows={months.slice(0, 6).map((m, i) => ({ ...m, prev: months[i + 1]?.sum ?? null }))} show={show} />
        <h3 className="ana-h">Last 10 training weeks</h3>
        <SummaryTable rows={weeks.slice(0, 10).map((w, i) => ({ ...w, label: i === 0 ? `This week · ${w.label}` : w.label, prev: weeks[i + 1]?.sum ?? null }))} show={show} onPick={(k) => setMonday(k)} />
        <p className="ana-note">
          Zones: pace from your training paces (easy, steady, threshold, interval, faster), heart rate from your zones ({model.zones.source ?? "your settings"}). VO2 max is each run's effective VO2 max from pace and heart rate; the arrow compares it with your shape at the
          time (↑ well above, ↗ above, → as usual, ↘ below, ↓ well below). Cadence, ground contact, vertical ratio and training effect come from Garmin.
        </p>
      </div>

      <aside className="ana-side">
        <Panel title="Running">
          <div className="ana-big">
            <b className="num">{n1(monthKm)} km</b>
            <small>
              {months[0].label} · {months[0].sum.n} runs
            </small>
          </div>
        </Panel>
        <Panel title="Calculations">
          <Calc label="Effective VO2max" value={show(f.current)} bar={f.current ? (f.current - 30) / 40 : 0} />
          <Calc label="Marathon shape" value={f.shape ? `${Math.round(f.shape.total * 100)} %` : "–"} bar={f.shape?.total ?? 0} />
          <Calc label="Fatigue (ATL)" value={now ? `${Math.round((now.atl / maxAtl) * 100)} %` : "–"} bar={now ? now.atl / maxAtl : 0} />
          <Calc label="Fitness (CTL)" value={now ? `${Math.round((now.ctl / maxCtl) * 100)} %` : "–"} bar={now ? now.ctl / maxCtl : 0} />
          <Calc label="Stress balance (TSB)" value={now ? `${now.tsb > 0 ? "+" : ""}${Math.round(now.tsb)}` : "–"} bar={now ? 0.5 + Math.max(-0.5, Math.min(0.5, now.tsb / Math.max(1, now.ctl) / 2)) : 0} />
          <Calc label="Workload ratio (A:C)" value={now && now.ctl ? (now.atl / now.ctl).toFixed(2) : "–"} bar={now && now.ctl ? Math.min(1, now.atl / now.ctl / 2) : 0} />
          <Calc label="Monotony" value={model.mono.monotony != null ? model.mono.monotony.toFixed(2) : "–"} bar={model.mono.monotony != null ? Math.min(1, model.mono.monotony / 2.5) : 0} />
          <Calc label="Training strain" value={String(Math.round(model.mono.strain))} bar={Math.min(1, model.mono.strain / 3000)} />
        </Panel>
        <Panel title="Prognosis">
          <Prognosis f={f} vd={model.vd} />
        </Panel>
        {model.paces && (
          <Panel title="Training paces">
            <table className="ana-mini">
              <tbody>
                {(
                  [
                    ["Recovery", model.paces.recovery],
                    ["Easy", model.paces.easy],
                    ["Long run", model.paces.long],
                    ["Marathon", model.paces.mp],
                    ["Half marathon", model.paces.hmp],
                    ["Threshold", model.paces.threshold],
                    ["10K", model.paces.tenk],
                    ["5K", model.paces.fivek],
                    ["Interval", model.paces.interval],
                  ] as [string, number | [number, number]][]
                ).map(([l, v]) => (
                  <tr key={l}>
                    <td>{l}</td>
                    <td className="r num">{Array.isArray(v) ? `${mmss(Math.min(v[0], v[1]))}–${mmss(Math.max(v[0], v[1]))}` : mmss(v)}/km</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        <Panel title="Health">
          <table className="ana-mini">
            <tbody>
              <tr>
                <td>Resting heart rate</td>
                <td className="r num">{h.rhr ? `${Math.round(h.rhr)} bpm` : "–"}</td>
              </tr>
              <tr>
                <td>Sleep</td>
                <td className="r num">{h.sleep_secs ? duration(h.sleep_secs).replace(/:\d\d$/, "") + " h" : "–"}</td>
              </tr>
              <tr>
                <td>HRV</td>
                <td className="r num">{h.hrv ? `${Math.round(h.hrv)} ms` : "–"}</td>
              </tr>
              <tr>
                <td>Training load (A:C)</td>
                <td className="r num">{now && now.ctl ? (now.atl / now.ctl).toFixed(2) : "–"}</td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </aside>
    </div>
  );
}

const mmss = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

function SumCells({ s }: { s: Sum }) {
  return (
    <>
      <td className="r num">{n1(s.dist / 1000)} km</td>
      <td className="r num">{duration(s.time)}</td>
      <td className="r num">{s.dist ? `${pace(s.dist, s.time)}/km` : "–"}</td>
      <td>
        <Bar shares={s.paceZ} />
      </td>
      <td className="r num">{s.hrTime ? `${Math.round(s.hrSum / s.hrTime)} bpm` : "–"}</td>
      <td>
        <Bar shares={s.hrZ} />
      </td>
      <td className="r num">{Math.round(s.elev)} m</td>
      <td className="r num">{avg(s.cad) ? `${Math.round(avg(s.cad)!)} spm` : "–"}</td>
      <td className="r num">{avg(s.gct) ? `${Math.round(avg(s.gct)!)} ms` : "–"}</td>
      <td className="r num">{avg(s.vr) ? `${n1(avg(s.vr)!)} %` : "–"}</td>
    </>
  );
}

function SummaryTable({ rows, show, onPick }: { rows: { key: string; label: string; sum: Sum; prev: Sum | null }[]; show: (v: number | null) => string; onPick?: (key: string) => void }) {
  return (
    <div className="ana-scroll">
      <table className="ana-table">
        <thead>
          <tr>
            <th />
            <th className="r">Runs</th>
            <th className="r">Distance</th>
            <th className="r">vs before</th>
            <th className="r">Duration</th>
            <th className="r">Pace</th>
            <th>Pace zones</th>
            <th className="r">avg. HR</th>
            <th>HR zones</th>
            <th className="r">Asc.</th>
            <th className="r">Cadence</th>
            <th className="r">GC</th>
            <th className="r">Vert. ratio</th>
            <th className="r">TRIMP</th>
            <th className="r">VO2max</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ch = r.prev && r.prev.dist > 0 ? (r.sum.dist - r.prev.dist) / r.prev.dist : null;
            const v = avg(r.sum.vo2);
            const pv = r.prev ? avg(r.prev.vo2) : null;
            return (
              <tr key={r.key}>
                <td>
                  {onPick ? (
                    <button type="button" className="ana-link" onClick={() => onPick(r.key)}>
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                <td className="r num">{r.sum.n}×</td>
                <SumCellsShort s={r.sum} ch={ch} />
                <td className="r num ana-trimp">{Math.round(r.sum.trimp)}</td>
                <td className="r num">
                  {show(v)} {v != null && pv != null ? arrowFor(v - pv) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SumCellsShort({ s, ch }: { s: Sum; ch: number | null }) {
  return (
    <>
      <td className="r num">{n1(s.dist / 1000)} km</td>
      <td className={"r num " + (ch == null ? "" : ch > 0.3 ? "ana-hot" : ch < -0.3 ? "ana-cold" : "muted")}>{ch == null ? "–" : `${ch > 0 ? "+" : ""}${Math.round(ch * 100)} %`}</td>
      <td className="r num">{duration(s.time)}</td>
      <td className="r num">{s.dist ? `${pace(s.dist, s.time)}/km` : "–"}</td>
      <td>
        <Bar shares={s.paceZ} />
      </td>
      <td className="r num">{s.hrTime ? `${Math.round(s.hrSum / s.hrTime)} bpm` : "–"}</td>
      <td>
        <Bar shares={s.hrZ} />
      </td>
      <td className="r num">{Math.round(s.elev)} m</td>
      <td className="r num">{avg(s.cad) ? `${Math.round(avg(s.cad)!)} spm` : "–"}</td>
      <td className="r num">{avg(s.gct) ? `${Math.round(avg(s.gct)!)} ms` : "–"}</td>
      <td className="r num">{avg(s.vr) ? `${n1(avg(s.vr)!)} %` : "–"}</td>
    </>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ana-panel">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function Calc({ label, value, bar }: { label: string; value: string; bar: number }) {
  return (
    <div className="ana-calc">
      <span>{label}</span>
      <span className="ana-calc-bar">
        <i style={{ width: `${Math.max(0, Math.min(1, bar)) * 100}%` }} />
      </span>
      <b className="num">{value}</b>
    </div>
  );
}

/** Runalyze's prognosis: from the VDOT time (fully trained for it) to the time your marathon shape allows. */
function Prognosis({ f, vd }: { f: Fitness; vd: number | null }) {
  if (!vd) return <p className="ana-note">Needs runs with heart rate, or a race result.</p>;
  const shape = f.shape?.total ?? 1;
  const dists: [string, number][] = [
    ["3 km", 3000],
    ["5 km", 5000],
    ["10 km", 10000],
    ["Half marathon", 21097.5],
    ["Marathon", 42195],
  ];
  return (
    <table className="ana-mini">
      <tbody>
        {dists.map(([l, m]) => {
          const a = predictTime(m, vd);
          const b = a * shapeFactor(m, shape);
          const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
          const fmt = (s: number) => duration(s);
          return (
            <tr key={l}>
              <td>{l}</td>
              <td className="r num">
                {Math.abs(hi - lo) < 3 ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`} <small className="muted">({pace(m, hi)}/km)</small>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
