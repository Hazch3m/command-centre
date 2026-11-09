import { useMemo, type CSSProperties } from "react";
import { notifyChanged, useDataVersion } from "../core/events";
import { kvGet, kvSet } from "../core/db";
import { addDays, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { useFitness } from "../modules/running/fitness";
import { loadGarminZones, loadZoneSettings, resolveZones } from "../modules/running/hrZones";
import type { Plan } from "../modules/running/plan";
import { pacesFor } from "../modules/running/planBuilder";
import { loadDetails, type Run } from "../modules/running/strava";
import { forecastWeek, type ForecastWeek } from "../modules/running/forecast";
import { mondayOf } from "../modules/running/plan";
import { loadOverrides } from "../modules/running/strava";
import { addMix, cutsFrom, FILL, FOCUS_KINDS, loadFocus, loadOf, plannedDaySeconds, plannedFocus, runFocus, shareOf, statusOf, TARGET, type FocusKind, type FocusMix } from "../modules/running/trainingFocus";
import { useRunningData } from "../modules/running/useRunning";
import { loadGarminLoadFocus, loadGarminLoadFocusDebug, type GarminLoadFocus } from "../modules/health/data";
import { Section, usePhoneNav } from "./common";

/** Your paces, heart-rate zones and recent run details: what the focus is worked out from. */
export function useFocusBasis() {
  const today = useToday();
  const { plan } = useRunningData();
  const f = useFitness(plan);
  const rv = useDataVersion("running");
  const q = useQuery(() => Promise.all([loadZoneSettings(), loadGarminZones(), loadDetails(addDays(today, -60))]), [rv, today]).data;
  return useMemo(() => {
    const vdot = f?.predictionBasis?.source === "manual" ? f.predictionBasis.vdot : (f?.current ?? null);
    const cuts = cutsFrom(vdot ? pacesFor(vdot) : null);
    const zones = f && q ? resolveZones(q[0], q[1], f.config) : null;
    const pz = (re: RegExp) => plan?.paces.find((x) => re.test(x.zone))?.now;
    return { cuts, zones, details: q?.[2] ?? new Map(), planZones: { MP: pz(/^Marathon pace/i), HMP: pz(/^Half marathon pace/i), T: pz(/^Threshold/i) }, ready: !!q };
  }, [f, q, plan]);
}

const pct = (x: number) => Math.round(x * 100);

/** The mix as a bar with its three shares underneath (Garmin's colours: blue, orange, purple). */
export function FocusBar({ mix, compact, label }: { mix: FocusMix | null; compact?: boolean; label?: string }) {
  if (!mix) return null;
  const parts = FOCUS_KINDS.filter((k) => mix[k.id] > 0.005);
  return (
    <div className={"fo" + (compact ? " compact" : "")} aria-label={`Training focus: ${parts.map((k) => `${k.label} ${pct(mix[k.id])}%`).join(", ")}`}>
      {label && <span className="fo-label">{label}</span>}
      <span className="fo-bar" aria-hidden="true">
        {parts.map((k) => (
          <i key={k.id} className={`fo-${k.id}`} style={{ flexGrow: mix[k.id] }} />
        ))}
      </span>
      <span className="fo-legend" aria-hidden="true">
        {parts.map((k) => (
          <span key={k.id}>
            <i className={`fo-${k.id}`} />
            {compact ? k.short : k.label} <b className="num">{pct(mix[k.id])}%</b>
          </span>
        ))}
      </span>
    </div>
  );
}

/** A planned session's focus. */
export function PlannedFocus({ text, compact, label }: { text: string; compact?: boolean; label?: string }) {
  const b = useFocusBasis();
  const mix = useMemo(() => plannedFocus(text, b.cuts, b.planZones), [text, b.cuts, b.planZones]);
  return <FocusBar mix={mix} compact={compact} label={label} />;
}

/** A finished run's focus. */
export function RunFocus({ run, compact, label }: { run: Run; compact?: boolean; label?: string }) {
  const b = useFocusBasis();
  if (!b.ready) return null;
  return <FocusBar mix={runFocus(run, b.details.get(run.id), b.zones, b.cuts)} compact={compact} label={label} />;
}

type Targets = Record<FocusKind, [number, number]>;
const GKEY: Record<FocusKind, "low" | "high" | "anaerobic"> = { low: "low", high: "high", anaerobic: "anaerobic" };

export type FocusSource = "garmin" | "own";
export const FOCUS_SOURCE_KEY = "running.focusSource";
export const loadFocusSource = async (): Promise<FocusSource> => ((await kvGet<string>(FOCUS_SOURCE_KEY, "garmin")) === "own" ? "own" : "garmin");
export async function saveFocusSource(v: FocusSource) {
  await kvSet(FOCUS_SOURCE_KEY, v);
  notifyChanged("ui");
}
export function useFocusSource(): FocusSource {
  const uv = useDataVersion("ui");
  return useQuery(loadFocusSource, [uv]).data ?? "garmin";
}

/** Garmin's own load focus when it's synced in the last few days (it's what your watch shows), unless you chose Pacelife's. */
export function useGarminLoadFocus(): GarminLoadFocus | null {
  const today = useToday();
  const hv = useDataVersion("health");
  const src = useFocusSource();
  const g = useQuery(loadGarminLoadFocus, [hv]).data;
  return src === "garmin" && g && g.date >= addDays(today, -10) ? g : null;
}

/** Healthy share of load for each: from Garmin's optimal ranges when synced, else typical ones. */
export function useShareTargets(): Targets {
  const g = useGarminLoadFocus();
  return useMemo(() => {
    if (!g) return TARGET;
    const mid = FOCUS_KINDS.reduce((s, k) => s + (g.target[GKEY[k.id]][0] + g.target[GKEY[k.id]][1]) / 2, 0) || 1;
    const t = {} as Targets;
    for (const k of FOCUS_KINDS) t[k.id] = [g.target[GKEY[k.id]][0] / mid, g.target[GKEY[k.id]][1] / mid];
    return t;
  }, [g]);
}

/** "ANAEROBIC_SHORTAGE" → "Short of anaerobic". */
function phraseText(p: string): string {
  const what = (x: string) => x.replace(/AEROBIC_LOW/g, "low aerobic").replace(/AEROBIC_HIGH/g, "high aerobic").replace(/ANAEROBIC/g, "anaerobic").replace(/_/g, " ").toLowerCase().trim();
  if (/^BALANCED/i.test(p)) return "Balanced";
  let m = /^(.*)_SHORTAGE$/i.exec(p);
  if (m) return `Short of ${what(m[1])}`;
  m = /^(.*)_FOCUS$/i.exec(p);
  if (m) return `Focused on ${what(m[1])}`;
  const t = what(p);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Garmin-style load focus: four weeks of load by kind against its optimal range, and what to run next. */
export function LoadFocusCard({ plan }: { plan?: Plan | null }) {
  const today = useToday();
  const nav = usePhoneNav();
  const { runs = [] } = useRunningData();
  const b = useFocusBasis();
  const g = useGarminLoadFocus();
  const targets = useShareTargets();
  const hv = useDataVersion("health");
  const src = useFocusSource();
  const dbg = useQuery(loadGarminLoadFocusDebug, [hv]).data;
  const raw = useQuery(loadGarminLoadFocus, [hv]).data;
  const lf = useMemo(() => (b.ready ? loadFocus(runs, b.details, b.zones, b.cuts, today) : null), [b, runs, today]);
  if (!plan) return null;
  type Row = { k: (typeof FOCUS_KINDS)[number]; v: number; lo: number; hi: number; big: string; share: number; zone: string; amount: string };
  let rows: Row[];
  let short: FocusKind | null = null;
  let verdict: string;
  let tone: "ok" | "short" | "over";
  if (g) {
    const total = g.low + g.high + g.anaerobic || 1;
    rows = FOCUS_KINDS.map((k) => {
      const v = g[GKEY[k.id]];
      const [lo, hi] = g.target[GKEY[k.id]];
      return { k, v, lo, hi, big: `${Math.round(v)}`, share: v / total, zone: `optimal ${Math.round(lo)}–${Math.round(hi)}`, amount: `${pct(v / total)}% of your load` };
    });
    let gap = 0;
    for (const r of rows)
      if (r.v < r.lo && (r.lo - r.v) / r.lo > gap) {
        gap = (r.lo - r.v) / r.lo;
        short = r.k.id;
      }
    const over = rows.find((r) => r.v > r.hi);
    verdict = g.phrase ? phraseText(g.phrase) : short ? `Short of ${FOCUS_KINDS.find((k) => k.id === short)!.label.toLowerCase()}` : "Balanced";
    tone = short ? "short" : over ? "over" : "ok";
  } else {
    if (!lf || !lf.total) return null;
    rows = FOCUS_KINDS.map((k) => {
      const [lo, hi] = targets[k.id];
      const v = lf.share[k.id];
      return { k, v, lo, hi, big: `${pct(v)}%`, share: v, zone: `zone ${pct(lo)}–${pct(hi)}%`, amount: `load ${Math.round(lf.load[k.id] / 10)}` };
    });
    short = lf.short;
    verdict = lf.short ? `Short of ${FOCUS_KINDS.find((k) => k.id === lf.short)!.label.toLowerCase()}` : lf.over ? `Heavy on ${FOCUS_KINDS.find((k) => k.id === lf.over)!.label.toLowerCase()}` : "Balanced";
    tone = lf.short ? "short" : lf.over ? "over" : "ok";
  }
  const max = Math.max(...rows.map((r) => Math.max(r.v, r.hi))) * 1.08;
  const fill = short ? FILL[short][0] : null;
  const fmtD = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const fmtZ = g ? (x: number) => `${Math.round(x)}` : (x: number) => `${pct(x)}%`;
  return (
    <Section title="Load focus · 4 weeks" className="p-padded">
      <div className="lf">
        <div className="lf-head">
          <span className={"lf-verdict " + tone}>{verdict}</span>
          <span className="lf-legend">
            <i /> {g ? "Optimal" : "Target zone"}
          </span>
        </div>
        {g && (
          <span className="lf-src">
            From your Garmin · {fmtD(addDays(g.date, -27))} – {fmtD(g.date)}
          </span>
        )}
        {rows.map((r) => {
          const st: "in" | "below" | "above" = r.v < r.lo ? "below" : r.v > r.hi ? "above" : "in";
          return (
            <div key={r.k.id} className={`lf-row2 lf-${st}`} style={{ "--k": KCOL[r.k.id] } as CSSProperties}>
              <div className="lf-top">
                <span className="lf-name">
                  <i className={`fo-${r.k.id}`} />
                  {r.k.label}
                </span>
                <span className="lf-big num">{r.big}</span>
                <span className={`lf-st lf-st-${st}`}>{st === "in" ? "✓ In zone" : st === "below" ? "↓ Below zone" : "↑ Above zone"}</span>
              </div>
              <ZoneTrack v={r.v} lo={r.lo} hi={r.hi} max={max} kind={r.k.id} fmt={fmtZ} />
              <div className="lf-nums">
                <span className="num">{r.amount}</span>
                <span className="num">{r.zone}</span>
              </div>
            </div>
          );
        })}
        <p className="p-hint">
          {g
            ? "Garmin's own numbers, as on your watch: the load from each kind of training over four weeks, against the optimal range for your fitness. The tinted band is that range and the upright line is where you are. All three in range means balanced training."
            : "Load is each run's minutes, weighted by how hard each kilometre was (harder minutes count for more), over the last four weeks. The tinted band on each bar is its target zone, and the upright line is where you are. This is Pacelife's own estimate, so it won't match your watch" + (src === "own" ? " (you can switch to Garmin's in Settings)." : ".")}
        </p>
        {!g && src === "garmin" && (
          <p className="lf-why">
            Garmin's load focus:{" "}
            {raw ? `last read for ${raw.date}, too old to show` : dbg ? (dbg.ok ? dbg.note : `not read yet (${dbg.note})`) : "not read yet: it comes with the next Garmin sync (pull down to refresh)"}
          </p>
        )}
        {fill && (
          <button
            type="button"
            className="lf-go"
            onClick={() => {
              try {
                sessionStorage.setItem("cc-wc-focus", fill.focus);
              } catch {
                /* private mode */
              }
              nav.push("workout");
            }}
          >
            <span>
              <small>Suggested workout</small>
              <b>{fill.why}</b>
            </span>
            <span className="p-chev">›</span>
          </button>
        )}
      </div>
    </Section>
  );
}

const KCOL: Record<FocusKind, string> = { low: "#3d9be9", high: "#f2913d", anaerobic: "#9b5cf0" };

/** A bar with the target zone drawn on it (tinted band with solid edges and its value at each edge) and a marker where you are. */
function ZoneTrack({ v, lo, hi, max, kind, fmt }: { v: number; lo: number; hi: number; max: number; kind: FocusKind; fmt: (x: number) => string }) {
  const at = (x: number) => `${Math.min(100, (x / max) * 100)}%`;
  return (
    <span className="lf-zone" aria-hidden="true">
      <span className="lf-track">
        <span className="lf-range" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <i className={`fo-${kind}`} style={{ width: at(v) }} />
        <span className="lf-mark" style={{ left: at(v) }} />
      </span>
      <span className="lf-scale">
        <span style={{ left: at(lo) }}>{fmt(lo)}</span>
        <span style={{ left: at(hi) }}>{fmt(hi)}</span>
      </span>
    </span>
  );
}

/** A week's load by focus: runs done so far, plus the sessions still to come. */
export function weekFocus(fw: ForecastWeek, today: string, b: ReturnType<typeof useFocusBasis>) {
  let load: FocusMix = { low: 0, high: 0, anaerobic: 0 };
  let planned = 0;
  for (const d of fw.days) {
    const ran = d.runs.length > 0 && d.date <= today;
    if (ran || d.date < today) {
      for (const r of d.runs) {
        const f = runFocus(r, b.details.get(r.id), b.zones, b.cuts);
        if (f) load = addMix(load, loadOf({ low: f.low * r.moving_time, high: f.high * r.moving_time, anaerobic: f.anaerobic * r.moving_time }));
      }
      continue;
    }
    const secs = plannedDaySeconds(d, b.cuts, b.planZones);
    if (secs) {
      load = addMix(load, loadOf(secs));
      planned++;
    }
  }
  const total = load.low + load.high + load.anaerobic;
  return total > 0 ? { load, total, share: shareOf(load), planned } : null;
}

/** The three shares as one stacked bar with the numbers on it. */
function FocusStack({ share }: { share: FocusMix }) {
  return (
    <span className="lfw-stack" aria-hidden="true">
      {FOCUS_KINDS.filter((k) => share[k.id] > 0.005).map((k) => (
        <i key={k.id} className={`fo-${k.id}`} style={{ flexGrow: share[k.id] }}>
          {share[k.id] >= 0.12 ? `${pct(share[k.id])}` : ""}
        </i>
      ))}
    </span>
  );
}

/** This week's load focus on the Plan's week: the % of each and whether it's in its zone. */
export function WeekFocusStrip({ fw }: { fw: ForecastWeek }) {
  const today = useToday();
  const targets = useShareTargets();
  const b = useFocusBasis();
  const w = useMemo(() => (b.ready ? weekFocus(fw, today, b) : null), [fw, today, b]);
  if (!w) return null;
  const future = fw.days[0].date > today;
  return (
    <div className="lfw-strip" aria-label={`Load focus this week: ${FOCUS_KINDS.map((k) => `${k.label} ${pct(w.share[k.id])}%`).join(", ")}`}>
      <span className="lfw-title">{future ? "Planned load focus" : "Load focus this week"}</span>
      <FocusStack share={w.share} />
      <span className="lfw-nums">
        {FOCUS_KINDS.map((k) => {
          const st = statusOf(k.id, w.share[k.id], targets);
          return (
            <span key={k.id} className={`lfw-n lf-st-${st}`}>
              <i className={`fo-${k.id}`} />
              {k.short} <b className="num">{pct(w.share[k.id])}%</b>
              <em>{st === "in" ? "✓" : st === "below" ? "↓" : "↑"}</em>
            </span>
          );
        })}
      </span>
    </div>
  );
}

/** Every week from this one to the end of the plan, with the planned % of each focus. */
export function PlanFocusWeeks({ plan, first, last }: { plan: Plan; first: string; last: string }) {
  const today = useToday();
  const targets = useShareTargets();
  const { runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const b = useFocusBasis();
  const thisMonday = mondayOf(today);
  const rows = useMemo(() => {
    if (!b.ready) return [];
    const out: { monday: string; label: string; w: NonNullable<ReturnType<typeof weekFocus>> }[] = [];
    for (let m = first < thisMonday ? thisMonday : first; m <= last; m = addDays(m, 7)) {
      const fw = forecastWeek(plan, m, runs, overrides);
      const w = weekFocus(fw, today, b);
      if (w) out.push({ monday: m, label: fw.week ? `W${fw.week.week}` : "", w });
    }
    return out;
  }, [b, plan, first, last, runs, overrides, today, thisMonday]);
  if (!rows.length) return null;
  // The next four weeks together (load focus is a four-week measure).
  const next4 = rows.slice(0, 4).reduce<FocusMix>((a, r) => addMix(a, r.w.load), { low: 0, high: 0, anaerobic: 0 });
  const s4 = shareOf(next4);
  const fmtD = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return (
    <Section title="Load focus by week" className="p-padded">
      <div className="lfw">
        <div className="lfw-next">
          <span className="lfw-title">Next 4 weeks as planned</span>
          <span className="lfw-nums">
            {FOCUS_KINDS.map((k) => {
              const st = statusOf(k.id, s4[k.id], targets);
              return (
                <span key={k.id} className={`lfw-n lf-st-${st}`}>
                  <i className={`fo-${k.id}`} />
                  {k.short} <b className="num">{pct(s4[k.id])}%</b>
                  <em>{st === "in" ? "✓" : st === "below" ? "↓" : "↑"}</em>
                </span>
              );
            })}
          </span>
        </div>
        <div className="lfw-head">
          <span />
          {FOCUS_KINDS.map((k) => (
            <span key={k.id} className="lfw-col">
              <i className={`fo-${k.id}`} />
              {k.short}
              <small>
                {pct(targets[k.id][0])}–{pct(targets[k.id][1])}%
              </small>
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.monday} className={"lfw-row" + (r.monday === thisMonday ? " now" : "")}>
            <span className="lfw-wk">
              <b>{r.monday === thisMonday ? "This week" : r.label || fmtD(r.monday)}</b>
              <small>{fmtD(r.monday)}</small>
            </span>
            {FOCUS_KINDS.map((k) => {
              const st = statusOf(k.id, r.w.share[k.id], targets);
              return (
                <span key={k.id} className={`lfw-cell lf-st-${st}`}>
                  <b className="num">{pct(r.w.share[k.id])}%</b>
                </span>
              );
            })}
            <FocusStack share={r.w.share} />
          </div>
        ))}
        <p className="p-hint">Each week's load from its planned sessions (this week: what you've run plus what's left). Green is inside its target zone. Single weeks swing (recovery and race weeks especially); the four weeks together are what count.</p>
      </div>
    </Section>
  );
}

export type { FocusKind };
