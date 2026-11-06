import { useState } from "react";
import { loadPlan } from "../running/plan";
import * as coach from "./coach";
import { sessionToWorkout, type Zones } from "./importWeek";

async function zones(): Promise<Zones> {
  const p = (await loadPlan()).plan.paces;
  const z = (re: RegExp) => p.find((x) => re.test(x.zone))?.now;
  return { MP: z(/^Marathon pace/i), HMP: z(/^Half marathon pace/i), T: z(/^Threshold/i) };
}

/**
 * One tap from a plan day to the Garmin calendar: the session becomes a
 * structured workout (warm-up, reps with pace targets, cool-down), is shown
 * for a check, then saved and scheduled. A workout already there with the
 * same name is updated rather than added twice.
 */
export function SendToWatch({ date, text, compact }: { date: string; text: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "busy" | "check" | "done">("idle");
  const [summary, setSummary] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [w, setW] = useState<ReturnType<typeof sessionToWorkout>>(null);
  const start = async () => {
    setState("busy");
    setMsg(null);
    const wk = sessionToWorkout(text, await zones());
    if (!wk) return setState("idle"), setMsg("Rest day: nothing to send.");
    const p = await coach.preview(wk);
    if (!p.ok) return setState("idle"), setMsg(p.message);
    setW(wk);
    setSummary(p.data);
    setState("check");
  };
  const send = async () => {
    if (!w) return;
    setState("busy");
    const day = await coach.getScheduled(date, date);
    const same = day.ok ? day.data.find((s) => s.name.trim().toLowerCase() === w.name.trim().toLowerCase()) : undefined;
    const r = same ? await coach.update(same.workoutId, w) : await coach.create(w, date);
    if (!r.ok) return setState("check"), setMsg(r.message);
    await coach.remember(same ? same.workoutId : (r.data as { workoutId: number }).workoutId, w);
    setState("done");
    setMsg(same ? "Updated on your Garmin calendar. It reaches the watch on its next sync." : "On your Garmin calendar. It reaches the watch on its next sync.");
  };
  return (
    <div className={"send-watch" + (compact ? " compact" : "")}>
      {state === "check" ? (
        <>
          <pre className="send-watch-summary">{summary}</pre>
          <div className="send-watch-actions">
            <button className="btn btn-primary" onClick={send}>
              Send to watch
            </button>
            <button className="btn ghost" onClick={() => setState("idle")}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <button className="btn send-watch-btn" disabled={state === "busy"} onClick={start}>
          {state === "busy" ? "Working…" : state === "done" ? "Sent ✓ (send again)" : "Send to watch"}
        </button>
      )}
      {msg && <div className={"small " + (state === "done" ? "tone-accent" : "muted")}>{msg}</div>}
    </div>
  );
}
