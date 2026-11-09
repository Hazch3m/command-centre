import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSwipe } from "./swipe";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { forecastRange, forecastWeek } from "../modules/running/forecast";
import { mondayOf, type Plan } from "../modules/running/plan";
import { openRun } from "../modules/running/RunView";
import { plannedKinds, RUN_TYPE_LABEL, typeOfDay, typeOfRun } from "../modules/running/runType";
import { km, pace } from "../modules/running/stats";
import { loadOverrides } from "../modules/running/strava";
import { useRunningData } from "../modules/running/useRunning";
import { TargetPrefs } from "../modules/running/TargetPrefs";
import { AutoSyncSetting } from "../modules/watch/AutoSyncSetting";
import { dayName, Section, usePhoneNav } from "./common";
import { Session } from "./Today";
import { ZoneIcon } from "./icons";
import { zoneOf } from "./EffortProfile";
import { PracticeTag } from "../modules/running/PracticeTag";
import { PlanCoach } from "../modules/running/PlanCoach";
import { isEmptyPlan } from "../core/account";

import { PlanList } from "../modules/running/PlanList";
import { PaceOnTrack } from "./PaceOnTrack";
import { RaceManager } from "../modules/running/RaceManager";
import { FitnessPredictor, GoalCarousel, PlanWeeksChart } from "./PlanGoals";
import { LoadFocusCard, PlanFocusWeeks, WeekFocusStrip } from "./Focus";
import { WeekAhead } from "./WeekAhead";

type View = "week" | "calendar" | "pace" | "progress";
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "week", label: "Week", icon: "M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M7.5 13h2M11 13h2M14.5 13h2" },
  { id: "calendar", label: "All weeks", icon: "M4 5h16M4 10h16M4 15h16M4 20h10" },
  { id: "pace", label: "Pace on point", icon: "M12 21a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM12 13l3.5-3.5M12 2v3" },
  { id: "progress", label: "Progress", icon: "M3 20h18M5 16l4-5 4 3 6-8M15 6h4v4" },
];
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
  const [view, setView] = useState<View>(() => (sessionStorage.getItem("cc-plan-view") as View | null) ?? "week");
  const pickView = (v: View) => {
    setView(v);
    sessionStorage.setItem("cc-plan-view", v);
  };
  // From this week (even when the plan starts later) to the plan's last week.
  const range = useMemo(() => {
    const r = plan ? forecastRange(plan, today) : null;
    return r ? { ...r, first: r.first < thisMonday ? r.first : thisMonday } : null;
  }, [plan, today, thisMonday]);
  const fw = useMemo(() => (plan ? forecastWeek(plan, monday, runs, overrides) : null), [plan, monday, runs, overrides]);
  // Swipe across the week (its days and session) to go to the week before or after.
  const weekRef = useRef<HTMLDivElement | null>(null);
  const can = (d: number) => !!range && addDays(monday, 7 * d) >= range.first && addDays(monday, 7 * d) <= range.last;
  useSwipe(weekRef, (d) => can(d) && setMonday(addDays(monday, 7 * d)), can);
  // A day asked for from elsewhere (a key session on Today): its week, that day, the session in view.
  const want = useRef<string | null>(null);
  useEffect(() => {
    if (want.current && mondayOf(want.current) === monday) {
      setSel(want.current);
      want.current = null;
      return;
    }
    setSel(monday === thisMonday ? today : monday);
  }, [monday]);
  useEffect(() => {
    const on = (e?: Event) => {
      let date = (e as CustomEvent<string> | undefined)?.detail ?? null;
      try {
        date ??= sessionStorage.getItem("cc-plan-day");
        sessionStorage.removeItem("cc-plan-day");
      } catch {
        /* private mode */
      }
      if (!date) return;
      setView("week");
      want.current = date;
      if (mondayOf(date) === monday) {
        setSel(date);
        want.current = null;
      } else setMonday(mondayOf(date));
      window.setTimeout(() => document.querySelector(".p-pane.on .p-weekdays")?.scrollIntoView({ behavior: "smooth", block: "start" }), 450);
    };
    on();
    window.addEventListener("cc:plan-day", on);
    return () => window.removeEventListener("cc:plan-day", on);
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
      <nav className="p-subnav" role="tablist" aria-label="Plan views">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" aria-selected={view === v.id} className={view === v.id ? "on" : ""} onClick={() => pickView(v.id)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={v.icon} />
            </svg>
            <span>{v.label}</span>
          </button>
        ))}
      </nav>
      {view === "calendar" && (
        <Section title="Every week" className="p-padded">
          <PlanWeeksChart plan={plan} first={range.first} last={range.last} />
        </Section>
      )}
      {view === "calendar" && <PlanFocusWeeks plan={plan} first={range.first} last={range.last} />}
      {view === "calendar" && (
        <div className="p-embed">
          <PlanList plan={plan} runs={runs} single />
        </div>
      )}
      {view === "pace" && (
        <PaceOnTrack plan={plan} runs={runs} />
      )}
      {view === "progress" && <PlanProgress plan={plan} first={range.first} last={range.last} />}
      {view === "week" && (
      <>
      <WeekAhead
        plan={plan}
        monday={monday}
        onDay={(d) => {
          setSel(d);
          window.setTimeout(() => document.querySelector(".p-pane.on .p-weekdays")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
        }}
      />
      <div ref={weekRef} data-noswipe className="p-weekswipe">
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
      <WeekFocusStrip fw={fw} />
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
      {fw.week || day.km || day.runs.length || day.race ? <Session d={day} label={dayName(day.date, today)} /> : <div className="p-hint center">{fw.block ? `${fw.block.key}. No day-by-day sessions this far out yet.` : "No plan this week."}</div>}
      </div>

      {/* On the screen itself (not the sliding page), and only while you're on Plan. */}
      {nav.tab === "training" &&
        !nav.pushed &&
        createPortal(
          <button type="button" className="p-wfab" onClick={() => nav.push("workout")} aria-label="Create a workout">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>Workout</span>
          </button>,
          document.body,
        )}

      <Section title="Plan check">
        <div className="p-coach">
          <PlanCoach plan={plan} monday={monday} compact />
        </div>
      </Section>

      <LoadFocusCard plan={plan} />

      <Section title="The week">
        {fw.days.map((d) => {
          const t = typeOfDay(d.kind);
          return (
            <button key={d.date} className={`p-row p-row-btn p-dayrow rt-${t}` + (d.date === sel ? " on" : "")} onClick={() => setSel(d.date)}>
              <span className="p-dayrow-dow">{dayName(d.date, today).replace(/ \d+ \w+$/, "")}</span>
              <span className="p-row-main">
                <span className="p-row-title">
                  <ZoneIcon zone={t === "rest" || !d.km ? "rest" : d.race ? "race" : zoneOf(d.text, d.kind)} title={d.text} size={15} />
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
      </>
      )}
    </div>
  );
}

/** How the plan's going: readiness for the next race, and every week's km, planned against done. */
function PlanProgress({ plan, first, last }: { plan: Plan; first: string; last: string }) {
  const nav = usePhoneNav();
  return (
    <>
      <GoalCarousel plan={plan} />
      <FitnessPredictor plan={plan} />
      <Section title="Week by week" className="p-padded">
        <PlanWeeksChart plan={plan} first={first} last={last} />
      </Section>
      <Section title="Races" className="p-padded">
        <div className="p-embed">
          <RaceManager plan={plan} />
        </div>
      </Section>
      <button className="p-row p-row-btn" onClick={() => nav.push("adjust")}>
        <span className="p-row-main">
          <span className="p-row-title">Change the plan</span>
          <span className="p-row-sub">Easier weeks, recovery, paces, a new build</span>
        </span>
        <span className="p-chev">›</span>
      </button>
    </>
  );
}
