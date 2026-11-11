import { SessionBump } from "./SessionBump";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSwipe } from "./swipe";
import { useDataVersion } from "../core/events";
import { addDays, parseKey, useToday } from "../core/time";
import { useQuery } from "../core/useQuery";
import { forecastRange, forecastWeek } from "../modules/running/forecast";
import { mondayOf } from "../modules/running/plan";
import { typeOfDay } from "../modules/running/runType";
import { km } from "../modules/running/stats";
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

import { PaceOnTrack } from "./PaceOnTrack";
import { RaceManager } from "../modules/running/RaceManager";
import { FitnessPredictor, GoalCarousel, PlanWeeksChart } from "./PlanGoals";
import { LoadFocusCard, PlanFocusWeeks, WeekFocusStrip } from "./Focus";
import { WeekAhead } from "./WeekAhead";
import { DayBars } from "./DayBars";

type View = "week" | "plan" | "progress" | "races";
const VIEWS: { id: View; label: string; icon: string }[] = [
  { id: "week", label: "Week", icon: "M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M7.5 13h2M11 13h2M14.5 13h2" },
  { id: "plan", label: "Plan", icon: "M4 5h16M4 10h16M4 15h16M4 20h10" },
  { id: "progress", label: "Progress", icon: "M3 20h18M5 16l4-5 4 3 6-8M15 6h4v4" },
  { id: "races", label: "Races", icon: "M6 21V4M6 4h11l-2 4 2 4H6" },
];
/** Old view names (All weeks, Pace on point) still land somewhere sensible. */
const viewOf = (v: string | null | undefined): View => (v === "calendar" ? "plan" : v === "pace" ? "progress" : v === "plan" || v === "progress" || v === "races" ? v : "week");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmt = (d: string) => `${parseKey(d).getDate()} ${MON[parseKey(d).getMonth()]}`;
const phase = (p: string) => p.replace(/\s*\(.*\)\s*$/, "").replace(/^Recovery and /, "");

/** Scrolls so the week's days sit just under the header, with the picked session below. */
function showWeekdays() {
  const el = document.querySelector(".p-pane.on .p-weekdays");
  if (el) window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - 110), behavior: "smooth" });
}

export function Training() {
  const today = useToday();
  const nav = usePhoneNav();
  const { plan, runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const thisMonday = mondayOf(today);
  const [monday, setMonday] = useState(thisMonday);
  const [sel, setSel] = useState(today);
  const [view, setView] = useState<View>(() => viewOf(sessionStorage.getItem("cc-plan-view")));
  const pickView = (raw: string) => {
    const v = viewOf(raw);
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
      window.setTimeout(() => showWeekdays(), 450);
    };
    on();
    window.addEventListener("cc:plan-day", on);
    const onView = (e: Event) => {
      const v = (e as CustomEvent<string>).detail;
      if (v) pickView(v);
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("cc:plan-view", onView);
    return () => {
      window.removeEventListener("cc:plan-day", on);
      window.removeEventListener("cc:plan-view", onView);
    };
  }, [monday]);
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
      {view === "plan" && (
        <>
          <div className="p-weekbar p-planbar">
            <button className="p-round" onClick={() => go(-1)} disabled={monday <= range.first} aria-label="Previous week">
              ‹
            </button>
            <div className="p-weekbar-mid">
              <b>
                {fw.week ? `Week ${fw.week.week}` : fmt(monday)}
                {off !== 0 && <span className="p-when">{off === 1 ? "next week" : off === -1 ? "last week" : off > 0 ? `in ${off} weeks` : `${-off} weeks ago`}</span>}
              </b>
              <span className="p-row-sub">
                {fmt(monday)} – {fmt(addDays(monday, 6))}
                {monday !== thisMonday && (
                  <>
                    {" · "}
                    <button type="button" className="link-btn" onClick={() => setMonday(thisMonday)}>
                      this week
                    </button>
                  </>
                )}
              </span>
            </div>
            <button className="p-round" onClick={() => go(1)} disabled={monday >= range.last} aria-label="Next week">
              ›
            </button>
          </div>
          <WeekAhead
            plan={plan}
            monday={monday}
            onDay={(d) => {
              setSel(d);
              pickView("week");
              window.setTimeout(() => showWeekdays(), 60);
            }}
          />
          <Section title="Every week" className="p-padded">
            <PlanWeeksChart plan={plan} first={range.first} last={range.last} sel={monday} onPick={setMonday} />
          </Section>
          <LoadFocusCard plan={plan} />
          <PlanFocusWeeks plan={plan} first={range.first} last={range.last} />
          <Section title="Your plan">
            <button className="p-row p-row-btn" onClick={() => nav.push("adjust")}>
              <span className="p-row-main">
                <span className="p-row-title">Change the plan</span>
                <span className="p-row-sub">{plan?.adjust ? `Your settings: ${Math.round(plan.adjust.volume * 100)}% mileage, ${plan.adjust.runDays ? `${plan.adjust.runDays.length} days a week` : "run days as planned"}` : plan?.built ? `Built for ${plan.built.raceName}: ${plan.built.level}, ${plan.built.days} days a week` : "Easier weeks, recovery, paces, a new build"}</span>
              </span>
              <span className="p-chev">›</span>
            </button>
            <button className="p-row p-row-btn" onClick={() => nav.push("plan")}>
              <span className="p-row-main">
                <span className="p-row-title">Every session, week by week</span>
                <span className="p-row-sub">The whole plan as a list</span>
              </span>
              <span className="p-chev">›</span>
            </button>
          </Section>
          <Section title="Targets">
            <TargetPrefs compact />
          </Section>
          <Section title="Watch">
            <AutoSyncSetting />
          </Section>
        </>
      )}
      {view === "progress" && (
        <>
          <GoalCarousel plan={plan} />
          <PaceOnTrack plan={plan} runs={runs} />
        </>
      )}
      {view === "races" && (
        <>
          <FitnessPredictor plan={plan} />
          <Section title="Your races" className="p-padded">
            <div className="p-embed">
              <RaceManager plan={plan} />
            </div>
          </Section>
        </>
      )}
      {view === "week" && (
      <>
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
          <span style={{ width: `${(fw.plannedKm ? Math.min(1, fw.actualKm / fw.plannedKm) : 0) * 100}%` }} />
        </span>
        {monday !== thisMonday && (
          <button className="p-link" onClick={() => setMonday(thisMonday)}>
            This week
          </button>
        )}
      </div>
      <div className="p-weekdays p-daybars">
        <DayBars days={fw.days} today={today} sel={sel} onDay={setSel} height={54} />
      </div>
      {fw.week || day.km || day.runs.length || day.race ? (
        <>
          <Session d={day} label={dayName(day.date, today)} />
          {fw.week && day.date >= today && !day.runs.length && <SessionBump plan={plan} d={day} week={fw} />}
        </>
      ) : fw.block ? (
        <div className="p-hint center">{`${fw.block.key}. No day-by-day sessions this far out yet.`}</div>
      ) : plan.weeks[0] && plan.weeks[0].start > monday ? (
        <div className="p-hint center">
          Your plan starts on {new Date(plan.weeks[0].start + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}. Until then, run easy as you like.{" "}
          <button type="button" className="link-btn" onClick={() => setMonday(plan.weeks[0].start)}>
            See week 1 ›
          </button>
        </div>
      ) : (
        <div className="p-hint center">No plan this week.</div>
      )}
      </div>

      <WeekFocusStrip fw={fw} />

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

      <Section title="Plan check">
        <div className="p-coach">
          <PlanCoach plan={plan} monday={monday} compact />
        </div>
        <button
          type="button"
          className="p-row p-row-btn p-adjust-btn"
          onClick={() => {
            try {
              sessionStorage.setItem("cc-adjust-view", "adjust");
            } catch {
              /* private mode */
            }
            nav.push("adjust");
          }}
        >
          <span className="p-row-main">
            <span className="p-row-title">Adjust plan</span>
            <span className="p-row-sub">Mileage, build-up, long runs and run days, without starting a new plan</span>
          </span>
          <span className="p-chev">›</span>
        </button>
      </Section>
      </>
      )}
    </div>
  );
}
