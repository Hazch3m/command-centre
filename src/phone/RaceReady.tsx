import { useState } from "react";
import { fmtTime } from "../modules/running/pbs";
import { readinessTone, type Readiness, type ReadinessPart } from "../modules/running/readiness";

const WHY: Record<ReadinessPart["key"], string> = {
  volume: "Weekly kilometres build the aerobic engine. It's the biggest part of readiness, and it's judged against what the race distance asks for at your fitness.",
  long: "The long run teaches the body to keep going: fuel, legs and mind. Shorter races need less of it.",
  specific: "Sessions at or around race pace make that pace feel familiar and efficient.",
  taper: "Easing off before the race lets the training land, so you start fresh. Too little and you're tired; too much and you go flat.",
  ramp: "Big jumps in weekly mileage are when injuries happen. Building around 10% a week is the safe rate.",
};

/** Race readiness two ways: if the race were today, and on race day if you follow the plan. Each part opens up. */
export function RaceReady({ r }: { r: Readiness }) {
  const [when, setWhen] = useState<"today" | "day">("day");
  const [open, setOpen] = useState<string | null>(null);
  const score = when === "today" ? r.today.score : r.score;
  const parts = when === "today" ? r.today.parts : r.parts;
  const time = when === "today" ? r.now : r.predicted;
  return (
    <div className="rr2">
      <div className="p-seg rr2-seg" role="tablist">
        <button role="tab" aria-selected={when === "today"} className={when === "today" ? "on" : ""} onClick={() => setWhen("today")}>
          Ready today
        </button>
        <button role="tab" aria-selected={when === "day"} className={when === "day" ? "on" : ""} onClick={() => setWhen("day")}>
          On race day, with the plan
        </button>
      </div>
      <div className="rr2-head">
        <span className={"rr2-score num " + readinessTone(score)}>
          {score}
          <small>%</small>
        </span>
        <span className="rr2-text">
          <b>{when === "today" ? "If the race were today" : "On race day, if you follow the plan"}</b>
          <span>
            {time ? (
              <>
                Likely <b className="num">{fmtTime(time)}</b>
                {when === "day" && r.range ? <span className="num"> ({fmtTime(r.range[0])}–{fmtTime(r.range[1])})</span> : null}
              </>
            ) : (
              "No time yet"
            )}
            {r.goal ? <span className="num"> · goal {fmtTime(r.goal)}</span> : null}
          </span>
        </span>
      </div>
      <div className="rr2-parts">
        {parts.map((p) => {
          const isOpen = open === p.key;
          return (
            <button key={p.key} type="button" className={"rr2-part" + (isOpen ? " open" : "")} onClick={() => setOpen(isOpen ? null : p.key)} aria-expanded={isOpen}>
              <span className="rr2-row">
                <span className="rr2-label">{p.label}</span>
                <span className="rr2-bar">
                  <i className={readinessTone(p.pct)} style={{ width: `${p.pct}%` }} />
                </span>
                <span className="num rr2-pct">{p.pct}%</span>
                <span className="rr2-chev" aria-hidden="true">
                  ›
                </span>
              </span>
              {isOpen && (
                <span className="rr2-more">
                  <b>{p.note}</b>
                  <span>{WHY[p.key]}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
