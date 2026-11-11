import { useEffect, useMemo, useRef, useState } from "react";
import { cachedPic, routePic } from "../modules/running/routeSnapshot";
import { RunFocus } from "./Focus";
import { addDays, parseKey, useToday } from "../core/time";
import { MedalBadges } from "../modules/running/Medals";
import { usePbData } from "../modules/running/PbsTab";
import { fmtTime } from "../modules/running/pbs";
import { RouteMap } from "../modules/running/route";
import { openRun } from "../modules/running/RunView";
import { plannedKinds, RUN_TYPE_LABEL, typeOfRun } from "../modules/running/runType";
import type { DayKind } from "../modules/running/forecast";
import { loadDetails, loadOverrides } from "../modules/running/strava";
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
  // Strava photos (and other details) for the runs listed.
  const photos = useQuery(() => loadDetails(addDays(today, -430)), [rv, today]).data;
  const kinds = useMemo(() => (plan ? plannedKinds(plan, addDays(today, -400), today, overrides) : new Map<string, DayKind>()), [plan, today, overrides]);
  const pb = usePbData();
  const [shown, setShown] = useState(15);
  const [pickWeek, setPickWeek] = useState<string | null>(null);
  // How many weeks back the chart's right edge sits: swipe it (or the arrows) for earlier weeks.
  const [back, setBack] = useState(0);

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
      const w = addDays(mondayOf(today), -7 * (i + back));
      out.push({ week: w, km: runs.filter((r) => r.date >= w && r.date <= addDays(w, 6)).reduce((s, r) => s + km(r.distance), 0) });
    }
    return out;
  }, [runs, today, back]);
  const oldest = runs.length ? runs.reduce((a, r) => (r.date < a ? r.date : a), today) : today;
  const canBack = addDays(mondayOf(today), -7 * (back + 11)) > oldest;
  const move = (by: number) => {
    if (by > 0 && !canBack) return;
    setBack((b) => Math.max(0, b + by * 6));
    setPickWeek(null);
  };
  const swipeX = useRef<number | null>(null);
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

      <div
        className="p-wchart-wrap"
        data-noswipe
        onTouchStart={(e) => (swipeX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          const dx = swipeX.current == null ? 0 : e.changedTouches[0].clientX - swipeX.current;
          swipeX.current = null;
          if (Math.abs(dx) > 45) move(dx > 0 ? 1 : -1);
        }}
      >
        <div className="p-wchart-nav">
          <button type="button" className="p-round" onClick={() => move(1)} disabled={!canBack} aria-label="Earlier weeks">
            ‹
          </button>
          <span className="num">
            {parseKey(weeks[0].week).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: back ? "numeric" : undefined })} – {parseKey(addDays(weeks[11].week, 6)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: back ? "numeric" : undefined })}
            {back > 0 && (
              <button type="button" className="p-link" onClick={() => (setBack(0), setPickWeek(null))}>
                Now
              </button>
            )}
          </span>
          <button type="button" className="p-round" onClick={() => move(-1)} disabled={back === 0} aria-label="Later weeks">
            ›
          </button>
        </div>
        <WeekChart weeks={weeks} today={today} pick={pickWeek} onPick={(w) => setPickWeek(pickWeek === w ? null : w)} />
      </div>
      {pickWeek && (
        <div className="p-weekpick">
          <div className="p-weekpick-head">
            <b>
              Week of {parseKey(pickWeek).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ·{" "}
              <span className="num">{weeks.find((w) => w.week === pickWeek)!.km.toFixed(1)} km</span>
            </b>
            <button className="p-link" onClick={() => setPickWeek(null)}>
              Close
            </button>
          </div>
          {feed
            .filter((r) => r.date >= pickWeek && r.date <= addDays(pickWeek, 6))
            .map((r) => (
              <RunCard key={r.id} r={r} today={today} kind={kinds.get(r.date)} medals={pb?.medals.get(r.id)} photo={photos?.get(r.id)?.photo} />
            ))}
          {!feed.some((r) => r.date >= pickWeek && r.date <= addDays(pickWeek, 6)) && <div className="p-hint">No runs that week.</div>}
        </div>
      )}

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
        {feed.length === 0 && <div className="p-hint">No runs yet. They arrive from Garmin or Apple Health once connected (Settings → Account).</div>}
      </Section>
      {feed.slice(0, shown).map((r) => (
        <RunCard key={r.id} r={r} today={today} kind={kinds.get(r.date)} medals={pb?.medals.get(r.id)} photo={photos?.get(r.id)?.photo} />
      ))}
      {feed.length > shown && (
        <button className="p-more" onClick={() => setShown((n) => n + 20)}>
          Show more runs
        </button>
      )}
    </div>
  );
}

function RunCard({ r, today, kind, medals, photo }: { r: Run; today: string; kind?: DayKind | null; medals: Parameters<typeof MedalBadges>[0]["medals"]; photo?: string | null }) {
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
      <RunFocus run={r} compact />
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
      {(r.polyline || photo) && (
        <div className={"p-runcard-map" + (photo && r.polyline ? " with-photo" : "")}>
          {r.polyline && <RouteThumb polyline={r.polyline} height={130} />}
          {photo && <img className="p-runcard-photo" src={photo} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        </div>
      )}
    </button>
  );
}

/** Kilometres a week, last 12 weeks: a scale up the side, the week's date under each bar; tap a bar for its runs. */
function WeekChart({ weeks, today, pick, onPick }: { weeks: { week: string; km: number }[]; today: string; pick: string | null; onPick: (w: string) => void }) {
  const max = Math.max(10, ...weeks.map((w) => w.km));
  const step = max > 120 ? 40 : max > 60 ? 20 : max > 30 ? 10 : 5;
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const now = mondayOf(today);
  return (
    <div className="p-wchart" role="group" aria-label="Kilometres per week, last 12 weeks">
      <div className="p-wchart-axis" aria-hidden="true">
        {ticks
          .slice()
          .reverse()
          .map((t) => (
            <span key={t} className="num">
              {t}
            </span>
          ))}
      </div>
      <div className="p-wchart-plot">
        <span className="p-wchart-grids" aria-hidden="true">
          {ticks.map((t) => (
            <i key={t} style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
        </span>
        {weeks.map((w, i) => {
          const d = parseKey(w.week);
          // Every other date (and always this week and the one you picked), so they never run together.
          const label = (weeks.length - 1 - i) % 2 === 0 || pick === w.week;
          return (
            <button
              key={w.week}
              type="button"
              className={"p-wchart-col" + (w.week === now ? " now" : "") + (pick === w.week ? " on" : "")}
              onClick={() => onPick(w.week)}
              aria-label={`Week of ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}: ${w.km.toFixed(1)} km`}
            >
              <span className="p-wchart-bar">
                {pick === w.week && <small className="num">{Math.round(w.km)}</small>}
                <i style={{ height: `${Math.max(1.5, (w.km / top) * 100)}%` }} />
              </span>
              <small className="p-wchart-date num">{label ? `${d.getDate()}/${d.getMonth() + 1}` : ""}</small>
            </button>
          );
        })}
      </div>
      <span className="p-wchart-unit">km</span>
    </div>
  );
}

/** The route on the real map once it's on screen (a picture, cached); the plain line until then. */
function RouteThumb({ polyline, height }: { polyline: string; height: number }) {
  const el = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(0);
  const [pic, setPic] = useState<string | null>(null);
  useEffect(() => {
    const box = el.current;
    if (!box) return;
    const width = Math.round(box.clientWidth) || 340;
    setW(width);
    const hit = cachedPic(polyline, width, height);
    if (hit) return setPic(hit);
    let gone = false;
    const io = new IntersectionObserver(
      (es) => {
        if (!es.some((e) => e.isIntersecting)) return;
        io.disconnect();
        routePic(polyline, width, height).then((u) => !gone && u && setPic(u));
      },
      { rootMargin: "300px" },
    );
    io.observe(box);
    return () => {
      gone = true;
      io.disconnect();
    };
  }, [polyline, height]);
  return (
    <div ref={el} className="p-routethumb" style={{ height }}>
      {pic ? <img src={pic} alt="" width={w} height={height} /> : <RouteMap polyline={polyline} height={height - 10} />}
    </div>
  );
}
