import { useEffect, useState } from "react";
import { DEFAULT_PREFS, loadRunPrefs, saveRunPrefs, type RunPrefs } from "./targets";

function Seg<T extends string | boolean>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tp-row">
      <span className="label">{label}</span>
      <span className="segmented small-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={String(o.v)} type="button" role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </span>
    </div>
  );
}

/** Run by pace or heart rate; how precise easy-run targets are; whether easy runs get verdicts. */
export function TargetPrefs({ compact }: { compact?: boolean }) {
  const [p, setP] = useState<RunPrefs>(DEFAULT_PREFS);
  useEffect(() => {
    loadRunPrefs().then(setP);
    const f = () => loadRunPrefs().then(setP);
    window.addEventListener("cc:plan-changed", f);
    return () => window.removeEventListener("cc:plan-changed", f);
  }, []);
  const set = (patch: Partial<RunPrefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    saveRunPrefs(next);
  };
  return (
    <div className={"target-prefs" + (compact ? " compact" : "")}>
      <Seg label="Run by" value={p.mode} options={[{ v: "pace", l: "Pace" }, { v: "hr", l: "Heart rate" }]} onChange={(v) => set({ mode: v })} />
      <Seg
        label="Easy runs"
        value={p.easyTarget}
        options={[
          { v: "exact", l: "Plan's range" },
          { v: "wide", l: "Wider range" },
          { v: "feel", l: "By feel" },
        ]}
        onChange={(v) => set({ easyTarget: v })}
      />
      <Seg label="Too fast / slow on easy runs" value={p.easyChecks} options={[{ v: false, l: "Off" }, { v: true, l: "On" }]} onChange={(v) => set({ easyChecks: v })} />
      <p className="tp-note muted small">
        {p.mode === "hr" ? "Targets show as heart-rate zones, and sessions are judged on heart rate (short reps aren't: heart rate lags too much). " : ""}
        {p.easyTarget === "feel" ? "Easy runs just say easy" + (p.mode === "hr" ? ", with a heart-rate ceiling. " : ". ") : p.easyTarget === "wide" ? "Easy runs get a range 15 s wider each way" + (p.mode === "hr" ? " (pace mode). " : ". ") : ""}
        {p.easyChecks ? "Easy, long and recovery runs are judged too." : "Easy, long and recovery runs aren't judged; sessions still are."}
      </p>
    </div>
  );
}
