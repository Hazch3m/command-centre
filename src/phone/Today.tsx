import { Fragment, useMemo, useState, type ReactNode } from "react";
import { WeekAhead } from "./WeekAhead";
import { WeekProgress } from "./WeekProgress";
import { kvGet, kvSet } from "../core/db";
import { notifyChanged } from "../core/events";
import { useDataVersion } from "../core/events";
import { addDays, todayKey, useNow, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { hhmm, loadEvents } from "../modules/calendar/data";
import { loadChecklist } from "../modules/checklist/data";
import { forecastWeek, type ForecastDay } from "../modules/running/forecast";
import { mondayOf, upcomingRaces } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { SendToWatch } from "../modules/watch/SendToWatch";
import { RUN_TYPE_LABEL, typeOfDay } from "../modules/running/runType";
import { duration, km, pace } from "../modules/running/stats";
import { loadDetails, loadOverrides } from "../modules/running/strava";
import { sessionKindOf } from "../modules/running/planBuilder";
import { EffortProfile, zoneOf } from "./EffortProfile";
import { useRunningData } from "../modules/running/useRunning";
import { addTaskFromText, focusGroup, loadTasks, setDone } from "../modules/tasks/data";
import { HabitButton } from "./Habits";
import { GettingStarted } from "./Account";
import { PracticeTag } from "../modules/running/PracticeTag";
import { plannerView } from "./Planner";
import { weatherModule } from "../modules/weather";
import { isEmptyPlan } from "../core/account";
import { CountUp, Section, usePhoneNav } from "./common";
import { DrawnTick, StreakIcon, ZoneIcon } from "./icons";
import { HealthPanel } from "./HealthPanel";
import { PlannedFocus, RunFocus } from "./Focus";
import type { Run } from "../modules/running/strava";

/** What a session is, in a word or two, from its text ("VO2 max", "Long run", …). */
export function sessionTitle(text: string, kind?: string): string {
  if (/VO2 max:/i.test(text)) return "VO2 max";
  if (/Threshold tempo:/i.test(text)) return "Tempo";
  if (/Threshold:/i.test(text)) return "Threshold";
  if (/Hill strength|hill reps/i.test(text)) return "Hills";
  if (/time trial/i.test(text)) return "Time trial";
  if (/Race pace:|\bHMP\b/i.test(text) || (/\bMP\b/.test(text) && !/long run/i.test(text))) return "Race pace";
  if (/fartlek/i.test(text)) return "Fartlek";
  if (/progression run/i.test(text)) return "Progression";
  if (/medium-long/i.test(text)) return "Medium-long";
  if (/long run/i.test(text) || kind === "long") return "Long run";
  if (/recovery/i.test(text)) return "Recovery run";
  return sessionKindOf(text) ?? "Easy run";
}
/** The session without its distance up front ("13 km with 3 km warm-up, …" → "3 km warm-up, …"). */
const detailOf = (text: string) => text.replace(/^\d+(?:\.\d+)?\s*km\s+(?:with\s+)?/i, "").replace(/^(?:VO2 max|Threshold tempo|Threshold|Hill strength|Race pace):\s*/i, "");

export function Session({ d, label, next }: { d: ForecastDay; label: string; next?: ForecastDay }) {
  const { plan } = useRunningData();
  const t = typeOfDay(d.kind);
  const rest = t === "rest" || !d.km;
  const zone = rest ? "rest" : d.race ? "race" : zoneOf(d.text, d.kind);
  const title = rest ? "Rest day" : d.race ? "Race day" : sessionTitle(d.text, d.kind);
  const detail = d.race ? `${d.race.name}${d.race.target ? `, aiming for ${d.race.target}` : ""}` : detailOf(d.text);
  return (
    <div className={`p-session z-${zone}`}>
      <div className="p-session-top">
        <span className="p-session-label">{label}</span>
        {!rest && (
          <span className="p-zone-pill">
            <ZoneIcon zone={zone} title={title} size={15} />
            {title}
          </span>
        )}
      </div>
      {rest ? (
        <div className="p-session-km rest">Rest</div>
      ) : (
        <div className="p-session-km num">
          <CountUp value={d.km ?? 0} decimals={(d.km ?? 0) % 1 ? 1 : 0} />
          <small>km</small>
        </div>
      )}
      {!rest && !d.race && <EffortProfile text={d.text} kind={d.kind} plan={plan} />}
      {!rest && !d.race && <PlannedFocus text={d.text} compact />}
      {!rest && (
        <div className="p-session-text">
          {detail}
          {!d.race && <PracticeTag text={d.text} kind={false} />}
        </div>
      )}
      {rest && <div className="p-session-text muted">Recovery is training too. Walk, stretch, sleep well.</div>}
      {rest && next && next.km ? (
        <div className={`p-next z-${next.race ? "race" : zoneOf(next.text, next.kind)}`}>
          <div className="p-next-head">
            <b className="num">Tomorrow, {next.km} km</b>
            <span>{next.race ? "Race day" : sessionTitle(next.text, next.kind)}</span>
          </div>
          {!next.race && <EffortProfile text={next.text} kind={next.kind} plan={plan} height={32} />}
        </div>
      ) : null}
      {(d.pace || d.strength) && !rest && (
        <div className="p-session-meta">
          {d.pace && <span className="p-chip num">{/\d:\d\d/.test(d.pace) ? `${d.pace}/km` : d.pace}</span>}
          {d.strength && <span className="p-chip">Strength {d.strength}</span>}
        </div>
      )}
      {!rest && !d.race && !d.runs.length && d.date >= todayKey() && <SendToWatch date={d.date} text={d.text} compact />}
      {d.runs.map((r) => (
        <button key={r.id} className="p-done" onClick={() => openRun(r.id)}>
          <span className="p-done-tick">✓</span>
          <span>
            Ran <b className="num">{km(r.distance).toFixed(1)} km</b> at <b className="num">{pace(r.distance, r.moving_time)}/km</b>
            {r.avg_hr ? `, ${Math.round(r.avg_hr)} bpm` : ""}
          </span>
          <span className="p-chev">›</span>
        </button>
      ))}
    </div>
  );
}

/** Your most recent run: the numbers that matter, its splits and route, one tap from the full view. */
export function LastRun() {
  const today = useToday();
  const { runs = [] } = useRunningData();
  const last = useMemo(() => [...runs].filter((r) => r.date <= today).sort((a, b) => (a.start_local < b.start_local ? 1 : -1))[0], [runs, today]);
  const rv = useDataVersion("running");
  const details = useQuery(() => (last ? loadDetails(last.date) : Promise.resolve(null)), [last?.id, rv]).data;
  if (!last) return null;
  const splits = details?.get(last.id)?.splits ?? [];
  const full = splits.filter((x) => x.distance > 900);
  const speeds = full.map((x) => x.distance / x.moving_time);
  const lo = Math.min(...speeds);
  const hi = Math.max(...speeds);
  const when = last.date === today ? "Today" : last.date === addDays(today, -1) ? "Yesterday" : new Date(last.date + "T12:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
  return (
    <button className="p-lastrun" onClick={() => openRun(last.id)}>
      <div className="p-lastrun-head">
        <span>
          <span className="p-session-label">Last run</span>
          <b className="p-lastrun-name">{last.name}</b>
          <span className="p-lastrun-when">
            {when}
            {last.start_local ? `, ${last.start_local.slice(11, 16)}` : ""}
          </span>
        </span>
        <span className="p-lastrun-km num">
          <CountUp value={km(last.distance)} decimals={1} />
          <small>km</small>
        </span>
      </div>
      <div className="p-lastrun-stats">
        <span>
          <b className="num">{pace(last.distance, last.moving_time)}</b>
          <small>/km pace</small>
        </span>
        <span>
          <b className="num">{duration(last.moving_time)}</b>
          <small>time</small>
        </span>
        {last.avg_hr ? (
          <span>
            <b className="num">{Math.round(last.avg_hr)}</b>
            <small>avg bpm</small>
          </span>
        ) : null}
        {last.elevation ? (
          <span>
            <b className="num">{Math.round(last.elevation)}</b>
            <small>m climbed</small>
          </span>
        ) : null}
      </div>
      <RunFocus run={last} compact />
      {full.length >= 2 && (
        <div className="p-splits" aria-label="Pace for each kilometre">
          {full.map((x, i) => {
            const v = x.distance / x.moving_time;
            // From 85% of the slowest kilometre's speed up, so a steady run looks steady and a fast finish shows.
            const f = Math.max(0, (v - lo * 0.85) / (hi - lo * 0.85));
            return <i key={i} style={{ height: `${Math.max(12, f * 100)}%` }} title={`km ${i + 1}: ${pace(x.distance, x.moving_time)}/km`} />;
          })}
        </div>
      )}
      {full.length >= 2 && (
        <div className="p-splits-legend">
          <span>km 1</span>
          <span>fastest {pace(1000, Math.round(1000 / hi))}/km</span>
          <span>km {full.length}</span>
        </div>
      )}
    </button>
  );
}

export function Today() {
  const today = useToday();
  const now = useNow("minute");
  const nav = usePhoneNav();
  const { plan, runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const weeks = useMemo(() => {
    if (!plan) return null;
    const m = mondayOf(today);
    return [forecastWeek(plan, m, runs, overrides), forecastWeek(plan, addDays(m, 7), runs, overrides)];
  }, [plan, runs, overrides, today]);
  const days = weeks ? [...weeks[0].days, ...weeks[1].days] : [];
  const todayRun = days.find((d) => d.date === today);
  const tomorrowRun = days.find((d) => d.date === addDays(today, 1));
  const week = weeks?.[0];
  const cv = useDataVersion("checklist");
  const habits = useQuery(() => loadChecklist(today), [cv, today]).data;
  const tv = useDataVersion("tasks");
  const tasks = useQuery(() => loadTasks(today), [tv, today]).data ?? [];
  const due = tasks.filter((t) => !t.done_at && (focusGroup(t, today) === "overdue" || focusGroup(t, today) === "today" || t.status === "doing"));
  const doneToday = tasks.filter((t) => t.done_at && t.done_day === today);
  const ev = useDataVersion("calendar");
  const events = useQuery(() => loadEvents(today, 2), [ev, today]).data ?? [];
  const upcoming = events
    .flatMap((d) => d.timed.filter((e) => e.endDate > now).map((e) => ({ e, day: d.date })))
    .slice(0, 4);
  const race = plan ? upcomingRaces(plan, today)[0] : null;
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const uv = useDataVersion("ui");
  const layout = fixLayout(useQuery(loadLayout, [uv]).data);
  const streak = useMemo(() => weekStreak(runs, today), [runs, today]);
  const [openDone, setOpenDone] = useState(false);
  const done = !!todayRun && todayRun.runs.length > 0;

  const blocks: Record<BlockId, ReactNode> = {
    session: todayRun && !isEmptyPlan(plan) && (done && !openDone ? <DoneToday d={todayRun} next={tomorrowRun} onOpen={() => setOpenDone(true)} /> : <Session d={todayRun} label={dayGreeting(now)} next={tomorrowRun} />),
    progress: plan && week && !isEmptyPlan(plan) && <WeekProgress plan={plan} fw={week} runs={runs} today={today} overrides={overrides} />,
    ahead: plan && !isEmptyPlan(plan) && <WeekAhead plan={plan} />,
    lastrun: <LastRun />,
    tiles: (
      <>
      <HealthPanel today={today} />
      <div className="p-tiles one">
        <button className="p-tile" onClick={() => nav.setTab("training")}>
          <span className="p-eyebrow">This week</span>
          <span className="p-big num">
            {week ? <CountUp value={week.actualKm} /> : "–"}
            <small> / {week?.plannedKm ?? "–"} km</small>
          </span>
          {week && <WeekBars days={week.days} today={today} />}
          {streak >= 2 && (
            <span className="p-streak">
              <StreakIcon size={14} />
              {streak} weeks in a row
            </span>
          )}
          {tomorrowRun && (
            <span className="p-tile-note">
              Tomorrow: {tomorrowRun.km ? `${tomorrowRun.km} km ${RUN_TYPE_LABEL[typeOfDay(tomorrowRun.kind)].toLowerCase()}` : "rest"}
            </span>
          )}
        </button>
      </div>
      </>
    ),
    workout: (
      <button type="button" className="wc-cta wc-cta-today" onClick={() => nav.push("workout")}>
        <i aria-hidden="true">+</i>
        <span className="wc-cta-text">
          <b>Create a workout</b>
          <span>Pick what to work on, get a suggestion, send it to your watch</span>
        </span>
      </button>
    ),
    habits: habits && habits.items.length > 0 && (
        <Section
          title="Habits"
          action={
            <button className="p-link" onClick={() => (plannerView("habits"), nav.setTab("planner"))}>
              {habits.items.filter((i) => (habits.today.get(i.id) ?? 0) >= i.target).length}/{habits.items.length} ›
            </button>
          }
          className="p-habits-strip"
        >
          <div className="p-habit-row">
            {habits.items.map((i) => (
              <HabitButton key={i.id} item={i} value={habits.today.get(i.id) ?? 0} />
            ))}
          </div>
        </Section>
      ),
    todo: (
      <Section
        title="To do"
        action={
          <button className="p-link" onClick={() => (plannerView("tasks"), nav.setTab("planner"))}>
            All tasks ›
          </button>
        }
      >
        {due.map((t) => (
          <label key={t.id} className="p-row p-task">
            <input type="checkbox" className="p-check" checked={false} onChange={() => setDone(t.id, true)} />
            <span className="p-row-main">
              <span className="p-row-title">{t.title}</span>
              {t.due && t.due < today && <span className="p-row-sub tone-danger">Overdue</span>}
            </span>
          </label>
        ))}
        {doneToday.map((t) => (
          <label key={t.id} className="p-row p-task done">
            <input type="checkbox" className="p-check" checked onChange={() => setDone(t.id, false)} />
            <span className="p-row-main">
              <span className="p-row-title">{t.title}</span>
            </span>
          </label>
        ))}
        {!due.length && !doneToday.length && <div className="p-row p-empty">Nothing due today.</div>}
        <form
          className="p-row p-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) addTaskFromText(`${draft} @today`).then(() => setDraft(""));
          }}
        >
          <span className="p-plus">+</span>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task for today" enterKeyHint="done" />
        </form>
      </Section>
    ),
    coming: (
      <Section
        title="Coming up"
        action={
          <button className="p-link" onClick={() => (plannerView("calendar"), nav.setTab("planner"))}>
            Calendar ›
          </button>
        }
      >
        {upcoming.map(({ e, day }) => (
          <div key={e.calendar_id + e.id + day} className="p-row p-event">
            <span className="p-event-bar" style={{ background: e.color ?? "var(--c-calendar)" }} />
            <span className="p-row-main">
              <span className="p-row-title">{e.summary}</span>
              <span className="p-row-sub">
                {day === today ? "" : "Tomorrow · "}
                {hhmm(e.startDate)}–{hhmm(e.endDate)}
                {e.location ? ` · ${e.location}` : ""}
              </span>
            </span>
            {e.startDate <= now && <span className="p-now">Now</span>}
          </div>
        ))}
        {!upcoming.length && <div className="p-row p-empty">Nothing else today or tomorrow.</div>}
      </Section>
    ),
    weather: (
      <Section
        title="Weather"
        action={
          <button className="p-link" onClick={() => nav.push("weather")}>
            Forecast ›
          </button>
        }
      >
        <div className="p-weather card card-weather">
          <div className="card-body">
            <weatherModule.Card editing={false} variant="tile" />
          </div>
        </div>
      </Section>
    ),
    race: race && (
        <button className="p-race" onClick={() => nav.push("fitness")}>
          <span className="p-race-days num">{race.days}</span>
          <span className="p-race-text">
            <span className="p-eyebrow">days to</span>
            <b>{race.name}</b>
            <span className="p-row-sub">Target {race.target}</span>
          </span>
          <span className="p-chev">›</span>
        </button>
      ),
  };
  return (
    <div className="p-screen">
      <GettingStarted />
      {layout.order
        .filter((id) => !layout.hidden.includes(id))
        .map((id) => (
          <Fragment key={id}>{blocks[id]}</Fragment>
        ))}
      {editing ? (
        <DashboardEditor layout={layout} onDone={() => setEditing(false)} />
      ) : (
        <button type="button" className="p-edit-dash" onClick={() => setEditing(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
          Customise this page
        </button>
      )}
    </div>
  );
}

const dayGreeting = (now: Date) => (now.getHours() < 12 ? "This morning" : now.getHours() < 17 ? "Today" : "This evening");

/** The week at a glance: a bar a day, as tall as planned, coloured by its zone, solid once run. */
function WeekBars({ days, today }: { days: ForecastDay[]; today: string }) {
  const max = Math.max(1, ...days.map((d) => Math.max(d.km ?? 0, d.runs.reduce((a, r) => a + r.distance / 1000, 0))));
  return (
    <span className="p-weekdots" aria-hidden="true">
      {days.map((d) => {
        const ran = d.runs.reduce((a, r) => a + r.distance / 1000, 0);
        const z = d.race ? "race" : zoneOf(d.text, d.kind);
        const h = Math.max(ran, d.km ?? 0) / max;
        return (
          <span key={d.date} className={`p-wd z-${z}` + (ran ? " ran" : "") + (d.date === today ? " today" : "")}>
            <i style={{ height: `${Math.max(8, h * 100)}%` }} />
            <b>{"MTWTFSS"[(new Date(d.date + "T12:00").getDay() + 6) % 7]}</b>
          </span>
        );
      })}
    </span>
  );
}

/** Weeks in a row (Monday to Sunday) with at least one run, counting this week once you've run in it. */
export function weekStreak(runs: Pick<Run, "date">[], today: string): number {
  const weeks = new Set(runs.map((r) => mondayOf(r.date)));
  let m = mondayOf(today);
  if (!weeks.has(m)) m = addDays(m, -7);
  let n = 0;
  while (weeks.has(m)) {
    n++;
    m = addDays(m, -7);
  }
  return n;
}

/** Today's session, done: a small tile with a tick (tap to see the session again) and what's next. */
function DoneToday({ d, next, onOpen }: { d: ForecastDay; next?: ForecastDay; onOpen: () => void }) {
  const ranKm = d.runs.reduce((a, r) => a + r.distance / 1000, 0);
  const secs = d.runs.reduce((a, r) => a + r.moving_time, 0);
  const zone = d.race ? "race" : !d.km ? "easy" : zoneOf(d.text, d.kind);
  const title = d.race ? "Race" : !d.km ? "Bonus run" : sessionTitle(d.text, d.kind);
  const nz = next ? (next.race ? "race" : !next.km ? "rest" : zoneOf(next.text, next.kind)) : null;
  const nTitle = next ? (next.race ? "Race day" : !next.km ? "Rest day" : sessionTitle(next.text, next.kind)) : null;
  return (
    <div className={`p-donetile z-${zone}`}>
      <button type="button" className="p-donetile-main" onClick={onOpen} aria-label="Show today's session">
        <DrawnTick size={34} />
        <span className="p-donetile-text">
          <span className="p-session-label">Today · done</span>
          <b>
            <ZoneIcon zone={zone} title={title} size={16} /> {title}
          </b>
          <span className="num">
            {ranKm.toFixed(1)}
            {d.km ? ` of ${d.km}` : ""} km · {pace(ranKm * 1000, secs)}/km
          </span>
        </span>
      </button>
      {next && nz && (
        <span className={`p-donetile-next z-${nz}`}>
          <small>Tomorrow</small>
          <ZoneIcon zone={nz} title={nTitle ?? ""} size={20} />
          <b className="num">{next.km ? `${next.km} km` : "Rest"}</b>
          <small>{next.km ? nTitle : ""}</small>
        </span>
      )}
    </div>
  );
}

// ---- Your Today page: which blocks, in what order ------------------------------------------

type BlockId = "session" | "progress" | "ahead" | "lastrun" | "tiles" | "workout" | "habits" | "todo" | "coming" | "weather" | "race";
const BLOCKS: { id: BlockId; label: string; hint: string }[] = [
  { id: "session", label: "Today's session", hint: "The run of the day, or a small tile once it's done" },
  { id: "progress", label: "Week progress", hint: "How much of the week you've trained, each day, and your streaks" },
  { id: "ahead", label: "Week ahead", hint: "This week's key sessions and the build to your race" },
  { id: "lastrun", label: "Last run", hint: "Distance, pace and splits" },
  { id: "tiles", label: "Health & this week", hint: "Readiness, sleep, HRV, training load, trends; km so far" },
  { id: "workout", label: "Create a workout", hint: "A big button for a one-off session" },
  { id: "habits", label: "Habits", hint: "Tick off today's habits" },
  { id: "todo", label: "To do", hint: "Tasks due today" },
  { id: "coming", label: "Coming up", hint: "Calendar for today and tomorrow" },
  { id: "weather", label: "Weather", hint: "Now and the next hours" },
  { id: "race", label: "Next race", hint: "Days to go" },
];
interface Layout {
  order: BlockId[];
  hidden: BlockId[];
}
const DEFAULT_LAYOUT: Layout = { order: BLOCKS.map((b) => b.id), hidden: ["workout"] };
const loadLayout = () => kvGet<Layout | null>("phone.today", null);
/** Saved layouts pick up blocks added later (in their default place). */
function fixLayout(l: Layout | null | undefined): Layout {
  if (!l) return DEFAULT_LAYOUT;
  const known = l.order.filter((id) => BLOCKS.some((b) => b.id === id));
  for (const b of BLOCKS) if (!known.includes(b.id)) known.splice(Math.min(known.length, BLOCKS.indexOf(b)), 0, b.id);
  return { order: known, hidden: l.hidden.filter((id) => known.includes(id)) };
}
async function saveLayout(l: Layout) {
  await kvSet("phone.today", l);
  await notifyChanged("ui");
}

function DashboardEditor({ layout, onDone }: { layout: Layout; onDone: () => void }) {
  const move = (i: number, d: -1 | 1) => {
    const order = [...layout.order];
    [order[i], order[i + d]] = [order[i + d], order[i]];
    void saveLayout({ ...layout, order });
  };
  const toggle = (id: BlockId) => void saveLayout({ ...layout, hidden: layout.hidden.includes(id) ? layout.hidden.filter((x) => x !== id) : [...layout.hidden, id] });
  return (
    <Section title="Customise Today" action={<button className="p-link" onClick={onDone}>Done</button>} className="p-dash-edit">
      {layout.order.map((id, i) => {
        const b = BLOCKS.find((x) => x.id === id)!;
        const on = !layout.hidden.includes(id);
        return (
          <div key={id} className={"p-row p-dash-row" + (on ? "" : " off")}>
            <label className="p-switch">
              <input type="checkbox" checked={on} onChange={() => toggle(id)} />
              <i aria-hidden="true" />
            </label>
            <span className="p-row-main">
              <span className="p-row-title">{b.label}</span>
              <span className="p-row-sub">{b.hint}</span>
            </span>
            <span className="p-dash-move">
              <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${b.label} up`}>
                ↑
              </button>
              <button type="button" disabled={i === layout.order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${b.label} down`}>
                ↓
              </button>
            </span>
          </div>
        );
      })}
      <button type="button" className="p-row p-row-btn p-dash-reset" onClick={() => void saveLayout(DEFAULT_LAYOUT)}>
        Back to the standard layout
      </button>
    </Section>
  );
}
