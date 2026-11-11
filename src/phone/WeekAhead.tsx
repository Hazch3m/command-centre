import { useMemo } from "react";
import { addDays, diffDays, parseKey, useToday } from "../core/time";
import { notifyChanged, useDataVersion } from "../core/events";
import { kvGet, kvSet } from "../core/db";
import { useQuery } from "../core/useQuery";
import { forecastWeek, raceKm } from "../modules/running/forecast";
import { mondayOf, priorityOf, upcomingRaces, type Plan } from "../modules/running/plan";
import { sessionKindOf } from "../modules/running/planBuilder";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { zoneOf } from "./EffortProfile";
import { ZoneIcon } from "./icons";
import { usePhoneNav, type Tab } from "./common";

const PHASE_COLOURS = ["#3d9be9", "#22b07d", "#f2913d", "#e8344e", "#9b5cf0", "#14a3a3"];
const phaseName = (p: string) =>
  p
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/^Recovery and /i, "")
    .replace(/^Phase\s*\d+\s*[:·-]\s*/i, "")
    .trim() || p;
const HIGHLIGHT_KEY = "plan.highlight";
const raceKey = (r: { name: string; date: string | null }) => `${r.date}|${r.name}`;
const shortName = (n: string) => (n.length > 22 ? n.slice(0, 21) + "…" : n);

/** Opens the Plan on that day's session (the Plan listens for this). */
export function openPlanDay(nav: { setTab: (t: Tab) => void }, date: string) {
  try {
    sessionStorage.setItem("cc-plan-view", "week");
    sessionStorage.setItem("cc-plan-day", date);
  } catch {
    /* private mode */
  }
  nav.setTab("training");
  window.dispatchEvent(new CustomEvent("cc:plan-day", { detail: date }));
}
const BLOCK_COLOURS: Record<string, string> = { Base: "#3d9be9", Build: "#22b07d", Sharpen: "#f2913d", "Race week": "#e8344e" };
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The week ahead and the build to your race, Runna-style: where this week sits in the whole plan
 * (phases along a line, you on it, the race at the end), the countdown, and the week's key sessions.
 */
export function WeekAhead({ plan, monday: given, onDay, compact, onOpen }: { plan: Plan; monday?: string; onDay?: (date: string) => void; compact?: boolean; onOpen?: () => void }) {
  const today = useToday();
  const nav = usePhoneNav();
  const { runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const monday = given ?? mondayOf(today);
  const fw = useMemo(() => forecastWeek(plan, monday, runs, overrides), [plan, monday, runs, overrides]);

  // The race this build is for: the one you picked, else the next A race, else the next race.
  const races = upcomingRaces(plan, today);
  const uv = useDataVersion("ui");
  const picked = useQuery(() => kvGet<string>(HIGHLIGHT_KEY, ""), [uv]).data ?? "";
  const race = races.find((r) => raceKey(r) === picked) ?? races.find((r) => priorityOf(r) === "A") ?? races[0] ?? null;

  // The plan's weeks up to the race, as phases along a line. A tune-up race (B or C) gets its own
  // block, periodised to it: build, then sharpen for the last two weeks, then race week. The goal
  // race shows the plan's phases, with the tune-ups on the line.
  const tuneUp = !!race && priorityOf(race) !== "A";
  const goal = races.find((r) => priorityOf(r) === "A") ?? null;
  let weeks: { start: string; end: string; phase: string }[] = plan.weeks.filter((w) => !race?.date || w.start <= race.date);
  if (tuneUp && race?.date) {
    const raceMon = mondayOf(race.date);
    const prev = plan.races
      // A block runs from the race before it that mattered (A or B); time trials don't split it.
      .filter((r) => r.date && !r.approx && r.date < race.date! && r !== race && priorityOf(r) !== "C")
      .map((r) => r.date!)
      .sort()
      .pop();
    const first = plan.weeks[0]?.start ?? raceMon;
    let from = prev && addDays(mondayOf(prev), 7) > first ? addDays(mondayOf(prev), 7) : first;
    if (diffDays(from, raceMon) / 7 > 15) from = addDays(raceMon, -15 * 7);
    const n0 = Math.max(1, diffDays(from, raceMon) / 7 + 1);
    weeks = Array.from({ length: n0 }, (_, i) => {
      const start = addDays(from, i * 7);
      const out = n0 - 1 - i;
      const phase = out === 0 ? "Race week" : out <= 2 ? "Sharpen" : n0 > 8 && out >= 7 ? "Base" : "Build";
      return { start, end: addDays(start, 6), phase };
    });
  }
  const idx = weeks.findIndex((w) => w.start <= addDays(monday, 6) && w.end >= monday);
  const segs: { name: string; from: number; to: number; colour: string }[] = [];
  for (const [i, w] of weeks.entries()) {
    const name = phaseName(w.phase || "");
    const last = segs[segs.length - 1];
    if (last && last.name === name) last.to = i;
    else segs.push({ name, from: i, to: i, colour: tuneUp ? BLOCK_COLOURS[name] ?? PHASE_COLOURS[segs.length % PHASE_COLOURS.length] : PHASE_COLOURS[segs.length % PHASE_COLOURS.length] });
  }
  const n = Math.max(1, weeks.length);
  const at = (i: number) => ((i + 0.5) / n) * 100;
  const cur = idx >= 0 ? segs.find((s) => s.from <= idx && idx <= s.to) : null;
  const phaseLeft = cur && idx >= 0 ? cur.to - idx : null;
  const dist = race ? (race.km ?? raceKm(race.name)) : null;
  const distWord = dist == null ? "race" : dist <= 6 ? "5K" : dist <= 12 ? "10K" : dist <= 25 ? "half" : "race";
  const summary = tuneUp
    ? cur?.name === "Race week"
      ? `Race week: a short mini taper, a few strides, then race the ${distWord}.`
      : cur?.name === "Sharpen"
        ? `Sharpening for the ${distWord}: a session at ${distWord} pace each week, the rest as planned, so you arrive sharp but not tired.`
        : `Building for the ${distWord}${goal && goal !== race ? ` on the way to ${goal.name}` : ""}: mileage and the usual sessions; the last two weeks sharpen for it.`
    : cur
      ? plan.phases.find((p) => phaseName(p.name) === cur.name || p.name.includes(cur.name))?.summary
      : null;
  // Tune-ups along the goal race's line.
  const marks = tuneUp || !race?.date ? [] : races.filter((r) => r !== race && r.date! < race.date!).map((r) => ({ r, i: weeks.findIndex((w) => w.start <= r.date! && w.end >= r.date!) })).filter((m) => m.i >= 0);

  const key = fw.days.filter((d) => d.kind === "key" || d.kind === "long" || d.kind === "race");
  const runsPlanned = fw.days.filter((d) => d.kind !== "rest" && !/^rest\b/i.test(d.text) && (d.km || d.text)).length;
  const daysTo = race?.date ? diffDays(today, race.date) : null;
  const done = fw.actualKm;
  const isThis = monday === mondayOf(today);
  const label = (text: string, kind: string) => (kind === "long" ? "Long run" : kind === "race" ? "Race" : /^([A-Z0-9][\w\s-]{1,18}):/.exec(text)?.[1] ?? sessionKindOf(text) ?? (/hill/i.test(text) ? "Hills" : /fartlek/i.test(text) ? "Fartlek" : /stride/i.test(text) ? "Strides" : /tempo/i.test(text) ? "Tempo" : "Session"));

  return (
    <section className={"wa" + (compact ? " compact" : "") + (onOpen ? " wa-tap" : "")} aria-label="Week ahead" onClick={onOpen} role={onOpen ? "button" : undefined}>
      <div className="wa-top">
        <span className="wa-eyebrow">
          {idx >= 0 ? `Week ${idx + 1} of ${weeks.length}` : tuneUp && weeks[0] && weeks[0].start > monday ? `Block starts ${parseKey(weeks[0].start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : isThis ? "This week" : "Week"}
          {cur ? ` · ${cur.name}` : ""}
        </span>
        {race && (
          <button type="button" className="wa-race" onClick={(e) => (e.stopPropagation(), nav.push("fitness"))}>
            <span className="wa-days num">{daysTo}</span>
            <small>{daysTo === 1 ? "day" : "days"} to go</small>
          </button>
        )}
      </div>
      <h3 className="wa-title">{race ? <>{tuneUp && (cur?.name === "Sharpen" || cur?.name === "Race week") ? "Sharpening for" : "Building to"} {race.name}</> : isThis ? "Your week ahead" : "The week"}</h3>
      {race && (
        <span className="wa-sub">
          {race.target ? `Goal ${race.target} · ` : ""}
          {parseKey(race.date!).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
          {phaseLeft != null && cur ? ` · ${phaseLeft === 0 ? `last week of ${cur.name.toLowerCase()}` : `${phaseLeft + 1} weeks of ${cur.name.toLowerCase()} left`}` : ""}
        </span>
      )}

      {!compact && races.length > 1 && (
        <div className="wa-picks" data-noswipe role="tablist" aria-label="Race to highlight">
          {races.map((r) => (
            <button
              key={raceKey(r)}
              type="button"
              role="tab"
              aria-selected={r === race}
              className={r === race ? "on" : ""}
              onClick={async () => {
                await kvSet(HIGHLIGHT_KEY, raceKey(r));
                notifyChanged("ui");
              }}
            >
              {shortName(r.name)}
              <small>{parseKey(r.date!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</small>
            </button>
          ))}
        </div>
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
            {marks.map((m) => (
              <span key={raceKey(m.r)} className="wa-tune" style={{ left: `${at(m.i)}%` }} title={m.r.name} />
            ))}
          </span>
          <span className="wa-phases">
            {segs.map((s) => (
              <span key={s.from} className={s === cur ? "on" : ""} style={{ left: `${(s.from / n) * 100}%`, width: `${((s.to - s.from + 1) / n) * 100}%`, color: s.colour }}>
                {s.to - s.from + 1 >= 2 || s === cur ? s.name : ""}
              </span>
            ))}
          </span>
          {!compact && marks.length > 0 && (
            <span className="wa-tunes">
              <i /> Tune-ups: {marks.map((m) => `${shortName(m.r.name)} ${parseKey(m.r.date!).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`).join(" · ")}
            </span>
          )}
        </div>
      )}

      {!compact && <div className="wa-stats">
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
      </div>}

      {!compact && key.length > 0 && (
        <div className="wa-keys">
          {key.map((d) => {
            const i = fw.days.indexOf(d);
            const past = d.date < today;
            const ran = d.runs.length > 0;
            return (
              <button type="button" key={d.date} className={"wa-key" + (ran ? " ran" : past ? " past" : "") + (d.date === today ? " today" : "")} onClick={() => (onDay ? onDay(d.date) : openPlanDay(nav, d.date))}>
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
      {!compact && summary && <p className="wa-note">{summary}</p>}
    </section>
  );
}
