import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDataVersion } from "../../core/events";
import { addDays, parseKey, useToday } from "../../core/time";
import { useQuery } from "../../core/useQuery";
import { forecastRange, forecastWeek, type ForecastDay, type ForecastWeek } from "./forecast";
import { checkDays } from "./pace";
import { PaceBadge } from "./PaceOnPoint";
import { mondayOf, type Plan } from "./plan";
import { openRun, openWeek } from "./RunView";
import { RUN_TYPE_LABEL, typeOfDay, typeOfRun, type RunType } from "./runType";
import { km, pace } from "./stats";
import { loadDetails, loadOverrides, type Run, type RunDetail } from "./strava";
import { DayEditor } from "./WeekCalendar";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const TYPES: RunType[] = ["easy", "long", "speed", "race"];

/** Short phase name: "Phase 1: Base (26 Oct – 3 Jan)" → "Phase 1: Base". */
const phaseName = (p: string) => p.replace(/\s*\(.*\)\s*$/, "").replace(/^Recovery and /, "");

/**
 * The plan as one long list of weeks, like Runna: the current week open and
 * highlighted, every day with its type colour, distance, pace and what you ran.
 * Click a week to open or close it, a day to change it.
 */
export function PlanList({ plan, runs }: { plan: Plan; runs: Run[] }) {
  const today = useToday();
  const thisMonday = mondayOf(today);
  const version = useDataVersion("running");
  const { data: overrides } = useQuery(loadOverrides, [version]);
  const { data: details } = useQuery(() => loadDetails(addDays(thisMonday, -21)), [version, thisMonday]);
  const range = useMemo(() => forecastRange(plan, today), [plan, today]);
  const weeks = useMemo(() => {
    const out: ForecastWeek[] = [];
    for (let m = range.first; m <= range.last; m = addDays(m, 7)) out.push(forecastWeek(plan, m, runs, overrides));
    return out;
  }, [plan, runs, overrides, range]);
  const [open, setOpen] = useState<Set<string>>(() => new Set([thisMonday]));
  const [showPast, setShowPast] = useState(false);
  const [editing, setEditing] = useState<{ d: ForecastDay; week: ForecastWeek } | null>(null);
  const current = useRef<HTMLDivElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);
  const toggle = (m: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });

  const past = weeks.filter((w) => w.monday < thisMonday);
  const shown = weeks.filter((w) => showPast || w.monday >= addDays(thisMonday, -7));
  const idx = plan.weeks.findIndex((w) => w.start <= today && today <= w.end);
  const hidden = past.length - shown.filter((w) => w.monday < thisMonday).length;

  let lastPhase = "";
  return (
    <div className="plist">
      <div className="plist-top">
        <div className="small">
          {idx >= 0 ? (
            <>
              <b>Week {idx + 1}</b> of {plan.weeks.length} · {phaseName(plan.weeks[idx].phase)}
            </>
          ) : (
            "Outside the plan's weeks"
          )}
        </div>
        <span className="rt-legend small">
          {TYPES.map((t) => (
            <span key={t}>
              <i className={`rt-swatch rt-${t}`} /> {RUN_TYPE_LABEL[t]}
            </span>
          ))}
        </span>
        <span className="inline">
          <button className="btn" onClick={() => setOpen(new Set(weeks.map((w) => w.monday)))}>
            Open all
          </button>
          <button className="btn" onClick={() => setOpen(new Set([thisMonday]))}>
            Just this week
          </button>
        </span>
      </div>
      {hidden > 0 && (
        <button className="btn ghost plist-more" onClick={() => setShowPast(true)}>
          Show {hidden} earlier week{hidden > 1 ? "s" : ""}
        </button>
      )}
      {shown.map((fw) => {
        const phase = fw.week ? phaseName(fw.week.phase) : fw.block?.name ?? "";
        const head = phase && phase !== lastPhase ? phase : null;
        lastPhase = phase || lastPhase;
        const isNow = fw.monday === thisMonday;
        return (
          <div key={fw.monday} ref={isNow ? current : undefined} className="pw-wrap">
            {head && (
              <div className="plist-phase">
                {head}
                {(() => {
                  const ph = plan.phases.find((p) => p.summary && phaseName(p.name) === head);
                  return ph ? <span className="muted small"> · {ph.summary}</span> : null;
                })()}
              </div>
            )}
            <WeekCard
              fw={fw}
              today={today}
              now={isNow}
              open={open.has(fw.monday)}
              onToggle={() => toggle(fw.monday)}
              details={details}
              onEdit={(d) => setEditing({ d, week: fw })}
            />
          </div>
        );
      })}
      {editing && createPortal(<DayEditor d={editing.d} week={editing.week} plan={plan} onClose={() => setEditing(null)} />, document.body)}
    </div>
  );
}

function WeekCard({
  fw,
  today,
  now,
  open,
  onToggle,
  details,
  onEdit,
}: {
  fw: ForecastWeek;
  today: string;
  now: boolean;
  open: boolean;
  onToggle: () => void;
  details?: Map<string, RunDetail>;
  onEdit: (d: ForecastDay) => void;
}) {
  const past = addDays(fw.monday, 6) < today;
  const planned = fw.plannedKm ?? (fw.block ? parseFloat(fw.block.km) || null : null);
  const pct = planned ? Math.min(1, fw.actualKm / planned) : 0;
  const checks = details ? checkDays(fw.days, details) : undefined;
  const runDays = fw.days.filter((d) => d.kind !== "rest" && (d.km ?? 0) > 0).length;
  const race = fw.days.find((d) => d.race);
  return (
    <section className={"pw-card" + (now ? " now" : "") + (past ? " past" : "") + (open ? " open" : "")}>
      <button className="pw-card-head" onClick={onToggle} aria-expanded={open}>
        <span className="pw-card-title">
          <b>{fw.week ? `Week ${fw.week.week}` : fw.block ? fw.block.name : "No plan"}</b>
          {now && <span className="pw-now">This week</span>}
          {race && <span className="rt-pill rt-race">🏁 {race.race!.name}</span>}
        </span>
        <span className="muted small">
          {fmt(fw.monday)} – {fmt(addDays(fw.monday, 6))}
          {fw.week ? ` · ${runDays} runs` : ""}
        </span>
        <span className="pw-dots" aria-hidden="true">
          {fw.days.map((d) => {
            const t = typeOfDay(d.kind);
            const done = d.runs.length > 0;
            return <i key={d.date} className={`rt-dot rt-${t}` + (done ? " done" : "") + (d.date === today ? " today" : "")} title={`${d.dow}: ${d.text || RUN_TYPE_LABEL[t]}`} />;
          })}
        </span>
        <span className="pw-km">
          <span className="num">
            {past || now ? <b>{fw.actualKm.toFixed(0)}</b> : null}
            {past || now ? " / " : ""}
            {planned != null ? `${Math.round(planned)} km` : fw.week ? `${fw.week.km} km` : ""}
          </span>
          {(past || now) && planned ? (
            <span className="pw-progress">
              <span style={{ width: `${pct * 100}%` }} className={pct >= 0.9 ? "ok" : pct >= 0.6 ? "mid" : "low"} />
            </span>
          ) : null}
        </span>
        <span className="pw-chev">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="pw-card-body">
          {fw.week?.notes && <div className="muted small pw-notes-line">{fw.week.notes}</div>}
          {!fw.week && fw.block && (
            <div className="muted small pw-notes-line">
              Focus: {fw.block.key}
              {fw.block.race ? ` · ${fw.block.race}` : ""}. No day-by-day sessions this far out yet.
            </div>
          )}
          {fw.week &&
            fw.days.map((d) => {
              const t = typeOfDay(d.kind);
              const isToday = d.date === today;
              const missed = d.date < today && !d.runs.length && t !== "rest" && (d.km ?? 0) > 0;
              return (
                <div key={d.date} className={`pw-day rt-row-${t}` + (isToday ? " today" : "") + (d.date < today ? " past" : "")}>
                  <span className="pw-day-date">
                    <b>{d.dow}</b>
                    <span className="muted">{parseKey(d.date).getDate()}</span>
                  </span>
                  <span className={`rt-pill rt-${t}`}>{RUN_TYPE_LABEL[t]}</span>
                  <button className="pw-day-text link" onClick={() => onEdit(d)} title="Change this day">
                    {d.race ? `${d.race.name}${d.race.target ? ` · ${d.race.target}` : ""}` : d.text || "Rest"}
                    {d.edited && <span className="wk-tag edited">Changed</span>}
                    {d.strength && <span className="wk-tag">Strength {d.strength}</span>}
                  </button>
                  <span className="pw-day-km num">{d.km ? `${d.km} km` : ""}</span>
                  <span className="pw-day-pace num muted">{d.pace && t !== "rest" ? (/\d:\d\d/.test(d.pace) ? `${d.pace}/km` : d.pace) : ""}</span>
                  <span className="pw-day-done">
                    {d.runs.map((r) => (
                      <button key={r.id} className={`link pw-run rt-text-${typeOfRun(r, d.kind)}`} onClick={() => openRun(r.id)} title={`${r.name}: laps, splits and charts`}>
                        ✓ <span className="num">{km(r.distance).toFixed(1)} km</span> <span className="num muted">{pace(r.distance, r.moving_time)}/km</span>
                        {checks?.get(r.id) && <PaceBadge c={checks.get(r.id)!} />}
                      </button>
                    ))}
                    {missed && <span className="muted small">not run</span>}
                  </span>
                </div>
              );
            })}
          <div className="pw-card-foot">
            <button className="link small" onClick={() => openWeek(fw.monday)}>
              See this week's runs ›
            </button>
            {fw.week && <span className="muted small">Planned ≈{fw.plannedKm ?? "–"} km{fw.week.km ? ` (plan says ${fw.week.km})` : ""}</span>}
          </div>
        </div>
      )}
    </section>
  );
}
