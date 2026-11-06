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
import { km, pace } from "../modules/running/stats";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { addTaskFromText, focusGroup, loadTasks, setDone } from "../modules/tasks/data";
import { HabitButton } from "./Habits";
import { GettingStarted } from "./Account";
import { plannerView } from "./Planner";
import { weatherModule } from "../modules/weather";
import { isEmptyPlan } from "../core/account";
import { Ring, Section, toneFor, usePhoneNav, useReadiness } from "./common";

export function Session({ d, label }: { d: ForecastDay; label: string }) {
  const t = typeOfDay(d.kind);
  const rest = t === "rest" || !d.km;
  return (
    <div className={`p-session rt-${t}`}>
      <div className="p-session-top">
        <span className="p-eyebrow">{label}</span>
        {!rest && <span className={`rt-pill rt-${t}`}>{RUN_TYPE_LABEL[t]}</span>}
      </div>
      {rest ? (
        <div className="p-session-km">Rest day</div>
      ) : (
        <div className="p-session-km num">
          {d.km}
          <small> km</small>
        </div>
      )}
      {!rest && <div className="p-session-text">{d.race ? `${d.race.name}${d.race.target ? ` · ${d.race.target}` : ""}` : d.text}</div>}
      <div className="p-session-meta">
        {d.pace && !rest && <span className="p-chip num">{/\d:\d\d/.test(d.pace) ? `${d.pace}/km` : d.pace}</span>}
        {d.strength && <span className="p-chip">Strength {d.strength}</span>}
      </div>
      {!rest && !d.race && !d.runs.length && d.date >= todayKey() && <SendToWatch date={d.date} text={d.text} compact />}
      {d.runs.map((r) => (
        <button key={r.id} className="p-done" onClick={() => openRun(r.id)}>
          <span className="p-done-tick">✓</span>
          <span>
            Ran <b className="num">{km(r.distance).toFixed(1)} km</b> at <b className="num">{pace(r.distance, r.moving_time)}/km</b>
            {r.avg_hr ? ` · ${Math.round(r.avg_hr)} bpm` : ""}
          </span>
          <span className="p-chev">›</span>
        </button>
      ))}
    </div>
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
  const pct = week?.plannedKm ? Math.min(1, week.actualKm / week.plannedKm) : 0;

  return (
    <div className="p-screen">
      <GettingStarted />
      {todayRun && !isEmptyPlan(plan) && <Session d={todayRun} label="Today's run" />}

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
          <span className="p-bar">
            <span style={{ width: `${pct * 100}%` }} />
          </span>
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
