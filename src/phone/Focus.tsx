import { useMemo, type CSSProperties } from "react";
import { useDataVersion } from "../core/events";
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

/** Garmin-style load focus: four weeks of load by kind against its healthy range, and what to run next. */
export function LoadFocusCard({ plan }: { plan?: Plan | null }) {
  const today = useToday();
  const nav = usePhoneNav();
  const { runs = [] } = useRunningData();
  const b = useFocusBasis();
  const lf = useMemo(() => (b.ready ? loadFocus(runs, b.details, b.zones, b.cuts, today) : null), [b, runs, today]);
  if (!lf || !lf.total || !plan) return null;
  const max = Math.max(...FOCUS_KINDS.map((k) => Math.max(lf.share[k.id], TARGET[k.id][1]))) * 1.08;
  const fill = lf.short ? FILL[lf.short][0] : null;
  const verdict = lf.short ? `Short of ${FOCUS_KINDS.find((k) => k.id === lf.short)!.label.toLowerCase()}` : lf.over ? `Heavy on ${FOCUS_KINDS.find((k) => k.id === lf.over)!.label.toLowerCase()}` : "Balanced";
  return (
    <Section title="Load focus · 4 weeks" className="p-padded">
      <div className="lf">
        <div className="lf-head">
          <span className={"lf-verdict" + (lf.short ? " short" : lf.over ? " over" : " ok")}>{verdict}</span>
          <span className="lf-legend">
            <i /> Target zone
          </span>
        </div>
        {FOCUS_KINDS.map((k) => {
          const [lo, hi] = TARGET[k.id];
          const v = lf.share[k.id];
          const amount = Math.round(lf.load[k.id] / 10);
          const range = [Math.round((lf.total * lo) / 10), Math.round((lf.total * hi) / 10)];
          const st = statusOf(k.id, v);
          return (
            <div key={k.id} className={`lf-row2 lf-${st}`} style={{ "--k": KCOL[k.id] } as CSSProperties}>
              <div className="lf-top">
                <span className="lf-name">
                  <i className={`fo-${k.id}`} />
                  {k.label}
                </span>
                <span className="lf-big num">{pct(v)}%</span>
                <span className={`lf-st lf-st-${st}`}>{st === "in" ? "✓ In zone" : st === "below" ? "↓ Below zone" : "↑ Above zone"}</span>
              </div>
              <ZoneTrack v={v} lo={lo} hi={hi} max={max} kind={k.id} />
              <div className="lf-nums">
                <span>
                  load <b className="num">{amount}</b>
                </span>
                <span className="num">
                  zone {pct(lo)}–{pct(hi)}% · {range[0]}–{range[1]}
                </span>
              </div>
            </div>
          );
        })}
        <p className="p-hint">
          Load is each run's minutes, weighted by how hard each kilometre was (harder minutes count for more), over the last four weeks. The tinted band on each bar is its target zone (the % at each edge), and the upright line is where you are. Like Garmin's load focus, all three in their zone means balanced training.
        </p>
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

/** A bar with the target zone drawn on it (tinted band with solid edges and its % at each edge) and a marker where you are. */
function ZoneTrack({ v, lo, hi, max, kind }: { v: number; lo: number; hi: number; max: number; kind: FocusKind }) {
  const at = (x: number) => `${Math.min(100, (x / max) * 100)}%`;
  return (
    <span className="lf-zone" aria-hidden="true">
      <span className="lf-track">
        <span className="lf-range" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <i className={`fo-${kind}`} style={{ width: at(v) }} />
        <span className="lf-mark" style={{ left: at(v) }} />
      </span>
      <span className="lf-scale">
        <span style={{ left: at(lo) }}>{pct(lo)}%</span>
        <span style={{ left: at(hi) }}>{pct(hi)}%</span>
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
          const st = statusOf(k.id, w.share[k.id]);
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
              const st = statusOf(k.id, s4[k.id]);
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
                {pct(TARGET[k.id][0])}–{pct(TARGET[k.id][1])}%
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
              const st = statusOf(k.id, r.w.share[k.id]);
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
