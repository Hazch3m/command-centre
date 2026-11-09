import { useMemo } from "react";
import { addDays, diffDays, parseKey, useToday } from "../core/time";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { forecastWeek } from "../modules/running/forecast";
import { mondayOf, priorityOf, upcomingRaces, type Plan } from "../modules/running/plan";
import { sessionKindOf } from "../modules/running/planBuilder";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { zoneOf } from "./EffortProfile";
import { ZoneIcon } from "./icons";
import { usePhoneNav } from "./common";

const PHASE_COLOURS = ["#3d9be9", "#22b07d", "#f2913d", "#e8344e", "#9b5cf0", "#14a3a3"];
const phaseName = (p: string) =>
  p
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/^Recovery and /i, "")
    .replace(/^Phase\s*\d+\s*[:·-]\s*/i, "")
    .trim() || p;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The week ahead and the build to your race, Runna-style: where this week sits in the whole plan
 * (phases along a line, you on it, the race at the end), the countdown, and the week's key sessions.
 */
export function WeekAhead({ plan, monday: given, onDay }: { plan: Plan; monday?: string; onDay?: (date: string) => void }) {
  const today = useToday();
  const nav = usePhoneNav();
  const { runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const monday = given ?? mondayOf(today);
  const fw = useMemo(() => forecastWeek(plan, monday, runs, overrides), [plan, monday, runs, overrides]);

  // The race this build is for: the next A race, else the next race.
  const races = upcomingRaces(plan, today);
  const race = races.find((r) => priorityOf(r) === "A") ?? races[0] ?? null;

  // The plan's weeks up to the race, as phases along a line.
  const weeks = plan.weeks.filter((w) => !race?.date || w.start <= race.date);
  const idx = weeks.findIndex((w) => w.start <= addDays(monday, 6) && w.end >= monday);
  const segs: { name: string; from: number; to: number; colour: string }[] = [];
  for (const [i, w] of weeks.entries()) {
    const name = phaseName(w.phase || "");
    const last = segs[segs.length - 1];
    if (last && last.name === name) last.to = i;
    else segs.push({ name, from: i, to: i, colour: PHASE_COLOURS[segs.length % PHASE_COLOURS.length] });
  }
  const n = Math.max(1, weeks.length);
  const at = (i: number) => ((i + 0.5) / n) * 100;
  const cur = idx >= 0 ? segs.find((s) => s.from <= idx && idx <= s.to) : null;
  const phaseLeft = cur && idx >= 0 ? cur.to - idx : null;
  const summary = cur ? plan.phases.find((p) => phaseName(p.name) === cur.name || p.name.includes(cur.name))?.summary : null;

  const key = fw.days.filter((d) => d.kind === "key" || d.kind === "long" || d.kind === "race");
  const runsPlanned = fw.days.filter((d) => d.kind !== "rest" && !/^rest\b/i.test(d.text) && (d.km || d.text)).length;
  const daysTo = race?.date ? diffDays(today, race.date) : null;
  const done = fw.actualKm;
  const isThis = monday === mondayOf(today);
  const label = (text: string, kind: string) => (kind === "long" ? "Long run" : kind === "race" ? "Race" : sessionKindOf(text) ?? (/hill/i.test(text) ? "Hills" : /fartlek/i.test(text) ? "Fartlek" : /stride/i.test(text) ? "Strides" : /tempo/i.test(text) ? "Tempo" : "Session"));

  return (
    <section className="wa" aria-label="Week ahead">
      <div className="wa-top">
        <span className="wa-eyebrow">
          {idx >= 0 ? `Week ${idx + 1} of ${weeks.length}` : isThis ? "This week" : "Week"}
          {cur ? ` · ${cur.name}` : ""}
        </span>
        {race && (
          <button type="button" className="wa-race" onClick={() => nav.push("fitness")}>
            <span className="wa-days num">{daysTo}</span>
            <small>{daysTo === 1 ? "day" : "days"} to go</small>
          </button>
        )}
      </div>
      <h3 className="wa-title">{race ? <>Building to {race.name}</> : isThis ? "Your week ahead" : "The week"}</h3>
      {race && (
        <span className="wa-sub">
          {race.target ? `Goal ${race.target} · ` : ""}
          {parseKey(race.date!).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
          {phaseLeft != null && cur ? ` · ${phaseLeft === 0 ? `last week of ${cur.name.toLowerCase()}` : `${phaseLeft + 1} weeks of ${cur.name.toLowerCase()} left`}` : ""}
        </span>
      )}

      {weeks.length > 1 && (
        <div className="wa-line" aria-hidden="true">
          <span className="wa-track">
            {segs.map((s) => (
              <i key={s.from} style={{ left: `${(s.from / n) * 100}%`, width: `${((s.to - s.from + 1) / n) * 100}%`, background: s.colour, opacity: idx >= 0 && s.to < idx ? 0.55 : 1 }} />
            ))}
            {idx >= 0 && <span className="wa-done" style={{ width: `${(idx / n) * 100}%` }} />}
            {idx >= 0 && <span className="wa-you" style={{ left: `${at(idx)}%` }} />}
            {race && <b className="wa-flag">⚑</b>}
          </span>
          <span className="wa-phases">
            {segs.map((s) => (
              <span key={s.from} className={s === cur ? "on" : ""} style={{ left: `${(s.from / n) * 100}%`, width: `${((s.to - s.from + 1) / n) * 100}%`, color: s.colour }}>
                {s.to - s.from + 1 >= 2 || s === cur ? s.name : ""}
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="wa-stats">
        <span>
          <b className="num">{fw.plannedKm ?? "–"}</b>
          <small>km planned</small>
        </span>
        <span>
          <b className="num">{runsPlanned}</b>
          <small>runs</small>
        </span>
        <span>
          <b className="num">{key.filter((d) => d.kind === "key").length}</b>
          <small>key sessions</small>
        </span>
        {isThis && (
          <span>
            <b className="num">{done.toFixed(0)}</b>
            <small>km done</small>
          </span>
        )}
      </div>

      {key.length > 0 && (
        <div className="wa-keys">
          {key.map((d) => {
            const i = fw.days.indexOf(d);
            const past = d.date < today;
            const ran = d.runs.length > 0;
            return (
              <button type="button" key={d.date} className={"wa-key" + (ran ? " ran" : past ? " past" : "") + (d.date === today ? " today" : "")} onClick={() => (onDay ? onDay(d.date) : nav.setTab("training"))}>
                <span className="wa-dow">{d.date === today ? "Today" : DOW[i]}</span>
                <ZoneIcon zone={d.race ? "race" : zoneOf(d.text, d.kind)} title={d.text} size={16} />
                <span className="wa-what">
                  <b>{label(d.text, d.kind)}</b>
                  <small>{d.text}</small>
                </span>
                {ran ? <span className="wa-tick">✓</span> : d.km ? <span className="wa-km num">{Math.round(d.km)} km</span> : null}
              </button>
            );
          })}
        </div>
      )}
      {summary && <p className="wa-note">{summary}</p>}
    </section>
  );
}
