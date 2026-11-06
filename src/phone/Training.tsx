import { useEffect, useMemo, useState } from "react";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { forecastRange, forecastWeek } from "../modules/running/forecast";
import { mondayOf } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { plannedKinds, RUN_TYPE_LABEL, typeOfDay, typeOfRun } from "../modules/running/runType";
import { km, pace } from "../modules/running/stats";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { TargetPrefs } from "../modules/running/TargetPrefs";
import { AutoSyncSetting } from "../modules/watch/AutoSyncSetting";
import { dayName, Section, usePhoneNav } from "./common";
import { Session } from "./Today";
import { PracticeTag } from "../modules/running/PracticeTag";
import { PlanCoach } from "../modules/running/PlanCoach";
import { isEmptyPlan } from "../core/account";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW1 = ["M", "T", "W", "T", "F", "S", "S"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const phase = (p: string) => p.replace(/\s*\(.*\)\s*$/, "").replace(/^Recovery and /, "");

export function Training() {
  const today = useToday();
  const nav = usePhoneNav();
  const { plan, runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const thisMonday = mondayOf(today);
  const [monday, setMonday] = useState(thisMonday);
  const [sel, setSel] = useState(today);
  const range = useMemo(() => (plan ? forecastRange(plan, today) : null), [plan, today]);
  const fw = useMemo(() => (plan ? forecastWeek(plan, monday, runs, overrides) : null), [plan, monday, runs, overrides]);
  useEffect(() => {
    setSel(monday === thisMonday ? today : monday);
  }, [monday]);
  const kinds = useMemo(() => (plan ? plannedKinds(plan, addDays(today, -70), today, overrides) : new Map()), [plan, today, overrides]);
  if (!plan || !fw || !range) return <div className="p-screen" />;
  if (isEmptyPlan(plan))
    return (
      <div className="p-screen">
        <section className="p-start">
          <h2>No training plan yet</h2>
          <p className="p-start-note">Pick your race, how many days a week you can run and your level: the plan is built from your recent running, with paces, long runs and a taper, and goes to your watch.</p>
          <button className="p-pill" onClick={() => nav.push("adjust")}>
            Build your plan
          </button>
        </section>
        <Section title="Targets">
          <TargetPrefs compact />
        </Section>
      </div>
    );
  const go = (n: number) => {
    const m = addDays(monday, 7 * n);
    if (m >= range.first && m <= range.last) setMonday(m);
  };
  const day = fw.days.find((d) => d.date === sel) ?? fw.days[0];
  const pct = fw.plannedKm ? Math.min(1, fw.actualKm / fw.plannedKm) : 0;
  const recent = [...runs].filter((r) => r.date <= today).slice(-3).reverse();
  const off = Math.round((parseKey(monday).getTime() - parseKey(thisMonday).getTime()) / (7 * 86400000));
  return (
    <div className="p-screen">
      <div className="p-weekbar">
        <button className="p-round" onClick={() => go(-1)} disabled={monday <= range.first} aria-label="Previous week">
          ‹
        </button>
        <div className="p-weekbar-mid">
          <b>
            {fw.week ? `Week ${fw.week.week}` : fw.block?.name ?? "No plan"}
            {off !== 0 && <span className="p-when">{off === 1 ? "next week" : off === -1 ? "last week" : off > 0 ? `in ${off} weeks` : `${-off} weeks ago`}</span>}
          </b>
          <span className="p-row-sub">
            {fmt(monday)} – {fmt(addDays(monday, 6))}
            {fw.week ? ` · ${phase(fw.week.phase)}` : ""}
          </span>
        </div>
        <button className="p-round" onClick={() => go(1)} disabled={monday >= range.last} aria-label="Next week">
          ›
        </button>
      </div>
      <div className="p-weekprog">
        <span className="num">
          <b>{fw.actualKm.toFixed(0)}</b> / {fw.plannedKm ?? "–"} km
        </span>
        <span className="p-bar">
          <span style={{ width: `${pct * 100}%` }} />
        </span>
        {monday !== thisMonday && (
          <button className="p-link" onClick={() => setMonday(thisMonday)}>
            This week
          </button>
        )}
      </div>
      <div className="p-weekdays">
        {fw.days.map((d, i) => {
          const t = typeOfDay(d.kind);
          return (
            <button key={d.date} className={`p-wday rt-${t}` + (d.date === sel ? " on" : "") + (d.date === today ? " today" : "") + (d.runs.length ? " done" : "")} onClick={() => setSel(d.date)}>
              <span className="p-wday-dow">{DOW1[i]}</span>
              <span className="p-wday-dot">{d.runs.length ? "✓" : d.km ? d.km : ""}</span>
              <span className="p-wday-num num">{parseKey(d.date).getDate()}</span>
            </button>
          );
        })}
      </div>
      {fw.week ? <Session d={day} label={dayName(day.date, today)} /> : <div className="p-hint center">{fw.block ? `${fw.block.key}. No day-by-day sessions this far out yet.` : "No plan this week."}</div>}

      <Section title="Plan check">
        <div className="p-coach">
          <PlanCoach plan={plan} monday={monday} compact />
        </div>
      </Section>

      <Section title="The week">
        {fw.days.map((d) => {
          const t = typeOfDay(d.kind);
          return (
            <button key={d.date} className={`p-row p-row-btn p-dayrow rt-${t}` + (d.date === sel ? " on" : "")} onClick={() => setSel(d.date)}>
              <span className="p-dayrow-dow">{dayName(d.date, today).replace(/ \d+ \w+$/, "")}</span>
              <span className="p-row-main">
                <span className="p-row-title">
                  {t === "rest" || !d.km ? "Rest" : d.text}
                  {t !== "rest" && !!d.km && <PracticeTag text={d.text} />}
                </span>
                {d.runs.length > 0 && <span className="p-row-sub tone-accent">✓ {d.runs.map((r) => `${km(r.distance).toFixed(1)} km`).join(" + ")}</span>}
              </span>
              <span className="p-dayrow-km num">{d.km ? `${d.km}` : ""}</span>
            </button>
          );
        })}
      </Section>

      <Section
        title="Recent runs"
        action={
          <button className="p-link" onClick={() => nav.setTab("runs")}>
            All runs
          </button>
        }
      >
        {recent.map((r) => {
          const t = typeOfRun(r, kinds.get(r.date));
          return (
            <button key={r.id} className="p-row p-row-btn p-run" onClick={() => openRun(r.id)}>
              <span className={`p-run-bar rt-${t}`} />
              <span className="p-row-main">
                <span className="p-row-title">{r.name}</span>
                <span className="p-row-sub">
                  {dayName(r.date, today)} · {RUN_TYPE_LABEL[t]}
                </span>
              </span>
              <span className="p-run-stats num">
                <b>{km(r.distance).toFixed(1)}</b> km
                <small>{pace(r.distance, r.moving_time)}/km</small>
              </span>
              <span className="p-chev">›</span>
            </button>
          );
        })}
      </Section>

      <Section title="Targets">
        <TargetPrefs compact />
      </Section>

      <Section title="Watch">
        <AutoSyncSetting />
      </Section>

      <Section title="More">
        <button className="p-row p-row-btn" onClick={() => nav.push("adjust")}>
          <span className="p-row-main">
            <span className="p-row-title">Your plan and races</span>
            <span className="p-row-sub">{plan?.adjust ? `Your settings: ${Math.round(plan.adjust.volume * 100)}% mileage, ${plan.adjust.runDays ? `${plan.adjust.runDays.length} days a week` : "run days as planned"}` : plan?.built ? `Built for ${plan.built.raceName}: ${plan.built.level}, ${plan.built.days} days a week` : "New plan for a race, mileage, long runs, run days"}</span>
          </span>
          <span className="p-chev">›</span>
        </button>
        <button className="p-row p-row-btn" onClick={() => nav.push("plan")}>
          <span className="p-row-main">
            <span className="p-row-title">Full plan, pace on point and progress</span>
          </span>
          <span className="p-chev">›</span>
        </button>
      </Section>
    </div>
  );
}
