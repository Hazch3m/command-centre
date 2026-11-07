import { useMemo, useState } from "react";
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
import { Ring, Section, toneFor, usePhoneNav, useReadiness } from "./common";

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
        {!rest && <span className="p-zone-pill">{title}</span>}
      </div>
      {rest ? (
        <div className="p-session-km rest">Rest</div>
      ) : (
        <div className="p-session-km num">
          {d.km}
          <small>km</small>
        </div>
      )}
      {!rest && !d.race && <EffortProfile text={d.text} kind={d.kind} plan={plan} />}
      {!rest && (
        <div className="p-session-text">
          {detail}
          {!d.race && <PracticeTag text={d.text} />}
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
          {km(last.distance).toFixed(1)}
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
  const ready = useReadiness(today);
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

  return (
    <div className="p-screen">
      <GettingStarted />
      {todayRun && !isEmptyPlan(plan) && <Session d={todayRun} label={dayGreeting(now)} next={tomorrowRun} />}
      <LastRun />

      <div className="p-tiles">
        <button className="p-tile" onClick={() => nav.push("health")}>
          <span className="p-eyebrow">Readiness</span>
          {ready ? (
            <div className="p-tile-row">
              <Ring value={ready.score} tone={toneFor(ready.score)} />
              <span className="p-tile-note">{ready.level}</span>
            </div>
          ) : (
            <span className="p-tile-note">Waiting for last night's sleep</span>
          )}
        </button>
        <button className="p-tile" onClick={() => nav.setTab("training")}>
          <span className="p-eyebrow">This week</span>
          <span className="p-big num">
            {week ? week.actualKm.toFixed(0) : "–"}
            <small> / {week?.plannedKm ?? "–"} km</small>
          </span>
          {week && <WeekBars days={week.days} today={today} />}
          {tomorrowRun && (
            <span className="p-tile-note">
              Tomorrow: {tomorrowRun.km ? `${tomorrowRun.km} km ${RUN_TYPE_LABEL[typeOfDay(tomorrowRun.kind)].toLowerCase()}` : "rest"}
            </span>
          )}
        </button>
      </div>

      {habits && habits.items.length > 0 && (
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
      )}

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

      {race && (
        <button className="p-race" onClick={() => nav.push("fitness")}>
          <span className="p-race-days num">{race.days}</span>
          <span className="p-race-text">
            <span className="p-eyebrow">days to</span>
            <b>{race.name}</b>
            <span className="p-row-sub">Target {race.target}</span>
          </span>
          <span className="p-chev">›</span>
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
