import { useMemo } from "react";
import { useDataVersion } from "../core/events";
import { addDays, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { useFitness } from "../modules/running/fitness";
import { loadGarminZones, loadZoneSettings, resolveZones } from "../modules/running/hrZones";
import type { Plan } from "../modules/running/plan";
import { pacesFor } from "../modules/running/planBuilder";
import { loadDetails, type Run } from "../modules/running/strava";
import { cutsFrom, FILL, FOCUS_KINDS, loadFocus, plannedFocus, runFocus, TARGET, type FocusKind, type FocusMix } from "../modules/running/trainingFocus";
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
        <span className={"lf-verdict" + (lf.short ? " short" : lf.over ? " over" : " ok")}>{verdict}</span>
        {FOCUS_KINDS.map((k) => {
          const [lo, hi] = TARGET[k.id];
          return (
            <div key={k.id} className="lf-row">
              <span className="lf-name">
                <i className={`fo-${k.id}`} />
                {k.label}
              </span>
              <span className="lf-track">
                <span className="lf-range" style={{ left: `${(lo / max) * 100}%`, width: `${((hi - lo) / max) * 100}%` }} />
                <i className={`fo-${k.id}`} style={{ width: `${(lf.share[k.id] / max) * 100}%` }} />
              </span>
              <b className="num">{pct(lf.share[k.id])}%</b>
            </div>
          );
        })}
        <p className="p-hint">Shaded: the healthy range. Each run counts by its kilometres' heart rate (harder minutes weigh more), like Garmin's load focus.</p>
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

export type { FocusKind };
