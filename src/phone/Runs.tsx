import { useMemo, useState } from "react";
import { addDays, parseKey, useToday } from "../core/time";
import { MedalBadges } from "../modules/running/Medals";
import { usePbData } from "../modules/running/PbsTab";
import { fmtTime } from "../modules/running/pbs";
import { RouteMap } from "../modules/running/route";
import { openRun } from "../modules/running/RunView";
import { plannedKinds, RUN_TYPE_LABEL, typeOfRun } from "../modules/running/runType";
import type { DayKind } from "../modules/running/forecast";
import { loadOverrides } from "../modules/running/strava";
import { useDataVersion } from "../core/events";
import { useQuery } from "../core/useQuery";
import { duration, km, pace } from "../modules/running/stats";
import type { Run } from "../modules/running/strava";
import { mondayOf } from "../modules/running/plan";
import { useRunningData } from "../modules/running/useRunning";
import { dayName, Section, usePhoneNav } from "./common";

/** Runs, Strava style: totals, a feed of runs with their maps and medals, and PBs. */
export function Runs() {
  const today = useToday();
  const nav = usePhoneNav();
  const { plan, runs = [] } = useRunningData();
  const rv = useDataVersion("running");
  const overrides = useQuery(loadOverrides, [rv]).data;
  const kinds = useMemo(() => (plan ? plannedKinds(plan, addDays(today, -400), today, overrides) : new Map<string, DayKind>()), [plan, today, overrides]);
  const pb = usePbData();
  const [shown, setShown] = useState(15);

  const totals = useMemo(() => {
    const sum = (from: string) => {
      const rs = runs.filter((r) => r.date >= from && r.date <= today);
      return { km: rs.reduce((s, r) => s + km(r.distance), 0), n: rs.length, time: rs.reduce((s, r) => s + r.moving_time, 0) };
    };
    return { week: sum(mondayOf(today)), month: sum(today.slice(0, 8) + "01"), year: sum(today.slice(0, 5) + "01-01") };
  }, [runs, today]);

  // The last 12 weeks, for the little bar chart.
  const weeks = useMemo(() => {
    const out: { week: string; km: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const w = addDays(mondayOf(today), -7 * i);
      out.push({ week: w, km: runs.filter((r) => r.date >= w && r.date <= addDays(w, 6)).reduce((s, r) => s + km(r.distance), 0) });
    }
    return out;
  }, [runs, today]);
  const maxW = Math.max(1, ...weeks.map((w) => w.km));
  const feed = useMemo(() => [...runs].sort((a, b) => (a.start_local < b.start_local ? 1 : -1)), [runs]);

  return (
    <div className="p-screen">
      <div className="p-totals">
        {(
          [
            ["This week", totals.week],
            ["This month", totals.month],
            [String(parseKey(today).getFullYear()), totals.year],
          ] as const
        ).map(([label, t]) => (
          <div key={label} className="p-total">
            <span className="p-total-label">{label}</span>
            <b className="num">{t.km.toFixed(t.km >= 100 ? 0 : 1)}</b>
            <span className="p-total-sub">km · {t.n} run{t.n === 1 ? "" : "s"}</span>
          </div>
        ))}
      </div>

      <div className="p-weekbars" aria-label="Kilometres per week, last 12 weeks">
        {weeks.map((w) => (
          <span key={w.week} className={"p-weekbar" + (w.week === mondayOf(today) ? " now" : "")} title={`${w.km.toFixed(1)} km`}>
            <i style={{ height: `${Math.max(3, (w.km / maxW) * 100)}%` }} />
          </span>
        ))}
      </div>

      {pb && pb.table.length > 0 && (
        <Section
          title="Personal bests"
          action={
            <button className="p-link" onClick={() => nav.push("pbs")}>
              All PBs
            </button>
          }
        >
          <div className="p-pbs">
            {pb.table
              .filter((r) => ["5K", "10K", "Half-Marathon", "Marathon"].includes(r.name))
              .map((r) => (
                <button key={r.name} className="p-pb" onClick={() => openRun(r.top[0].runId)}>
                  <span className="p-pb-label">{r.label}</span>
                  <b className="num">{fmtTime(r.top[0].seconds)}</b>
                  <span className="p-pb-date">{parseKey(r.top[0].date).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span>
                </button>
              ))}
          </div>
        </Section>
      )}

      <Section title="Your runs">
        {feed.length === 0 && <div className="p-hint">No runs yet. They arrive from Garmin.</div>}
      </Section>
      {feed.slice(0, shown).map((r) => (
        <RunCard key={r.id} r={r} today={today} kind={kinds.get(r.date)} medals={pb?.medals.get(r.id)} />
      ))}
      {feed.length > shown && (
        <button className="p-more" onClick={() => setShown((n) => n + 20)}>
          Show more runs
        </button>
      )}
    </div>
  );
}

function RunCard({ r, today, kind, medals }: { r: Run; today: string; kind?: DayKind | null; medals: Parameters<typeof MedalBadges>[0]["medals"] }) {
  const t = typeOfRun(r, kind);
  const time = r.start_local?.slice(11, 16);
  return (
    <button className="p-runcard" onClick={() => openRun(r.id)}>
      <div className="p-runcard-head">
        <span className={`p-run-bar rt-${t}`} />
        <span className="p-row-main">
          <span className="p-row-title">{r.name}</span>
          <span className="p-row-sub">
            {dayName(r.date, today)}
            {time ? ` · ${time}` : ""} · {RUN_TYPE_LABEL[t]}
          </span>
        </span>
        <MedalBadges medals={medals} max={3} />
      </div>
      <div className="p-runcard-stats">
        <span>
          <small>Distance</small>
          <b className="num">{km(r.distance).toFixed(2)} km</b>
        </span>
        <span>
          <small>Pace</small>
          <b className="num">{pace(r.distance, r.moving_time)}/km</b>
        </span>
        <span>
          <small>Time</small>
          <b className="num">{duration(r.moving_time)}</b>
        </span>
        {r.avg_hr ? (
          <span>
            <small>Avg HR</small>
            <b className="num">{Math.round(r.avg_hr)}</b>
          </span>
        ) : null}
      </div>
      {r.polyline && (
        <div className="p-runcard-map">
          <RouteMap polyline={r.polyline} height={120} />
        </div>
      )}
    </button>
  );
}
