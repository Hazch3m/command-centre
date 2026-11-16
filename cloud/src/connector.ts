/**
 * Pacelife for Claude: a read-only connector (MCP, the Model Context Protocol, over HTTP) that lets you
 * ask Claude about your running: your history, how you've improved, your plan and your predicted paces.
 *
 * You turn it on in the app (Settings → Claude), which makes a private link; you add that link to Claude
 * as a custom connector. It only reads. Runs that came through Strava's API are left out (Strava doesn't
 * allow its API data to be given to AI); runs from Garmin, Apple Health and your own Strava archive are in.
 */
import type { Database } from "sql.js";
import { getContext, setContext, type Creds } from "./appBackend";
import { loadPlan, mondayOf, upcomingRaces, type Plan } from "../../src/modules/running/plan";
import { computeFitness, loadFitnessConfig, pickShape, SHAPE_DEFAULTS, type Fitness, type ShapeOptions } from "../../src/modules/running/fitness";
import { forecastWeek, raceKm } from "../../src/modules/running/forecast";
import { pacesFor } from "../../src/modules/running/planBuilder";
import { predictTime } from "../../src/modules/running/vo2";
import { loadDetails, loadOverrides, loadReadings, type Run, type RunDetail } from "../../src/modules/running/strava";
import { latestPredictions } from "../../src/modules/health/data";
import { kvGet, db as appDb } from "../../src/core/db";
import { addDays } from "../../src/core/time";

export interface Copy {
  db: Database;
  files: Record<string, string>;
  creds: Creds;
}

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// ---- Formatting ------------------------------------------------------------------------------

const clock = (s: number | null | undefined) => {
  if (s == null || !Number.isFinite(s)) return null;
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const x = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const pace = (secPerKm: number | null | undefined) => (secPerKm && Number.isFinite(secPerKm) ? `${clock(secPerKm)}/km` : null);
const r1 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null | undefined) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const src = (id: string) => (id.startsWith("g") ? "Garmin" : id.startsWith("hk") ? "Apple Health" : id.startsWith("sx") ? "Strava archive" : "other");
const pacesOut = (v: number) => {
  const p = pacesFor(v);
  const range = (a: [number, number]) => `${clock(a[0])}–${clock(a[1])}/km`;
  return {
    vdot: r1(v),
    easy: range(p.easy),
    long_run: range(p.long),
    recovery: range(p.recovery),
    marathon: pace(p.mp),
    half_marathon: pace(p.hmp),
    threshold: pace(p.threshold),
    ten_k: pace(p.tenk),
    five_k: pace(p.fivek),
    interval_vo2max: pace(p.interval),
  };
};

// ---- Reading your data (the app's own code, on a copy of your data) ---------------------------

/**
 * Your runs for the connector: Garmin's, then your Strava archive's and Apple Health's where Garmin doesn't
 * have the same run (within 5 minutes). Never rows from Strava's API.
 */
async function connectorRuns(from: string): Promise<Run[]> {
  const near = (cond: string) => `EXISTS (SELECT 1 FROM strava_activities s WHERE (${cond}) AND s.start_epoch BETWEEN a.start_epoch - 300 AND a.start_epoch + 300)`;
  return appDb.select<Run>(
    `SELECT id, date, start_local, COALESCE((SELECT json_extract(k.value, '$.name') FROM kv k WHERE k.key = 'run.meta.' || a.id), name) AS name,
            sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, workout_type, polyline, gear_id
     FROM strava_activities a
     WHERE date >= ? AND (
       a.id LIKE 'g%'
       OR (a.id LIKE 'sx%' AND NOT ${near("s.id LIKE 'g%'")})
       OR (a.id LIKE 'hk%' AND NOT ${near("s.id LIKE 'g%' OR s.id LIKE 'sx%'")})
     )
     ORDER BY start_local`,
    [from],
  );
}

interface World {
  today: string;
  plan: Plan | null;
  planError: string | null;
  runs: Run[];
  details: Map<string, RunDetail>;
  fitness: Fitness | null;
  overrides: Map<string, string>;
}

async function readWorld(today: string): Promise<World> {
  let plan: Plan | null = null;
  let planError: string | null = null;
  try {
    const r = await loadPlan();
    plan = r.plan;
    planError = r.error;
  } catch (e) {
    planError = `No plan could be read (${(e as Error)?.message ?? e}).`;
  }
  const runs = await connectorRuns("2015-01-01");
  const allDetails = await loadDetails("2015-01-01");
  const details = new Map([...allDetails].filter(([id]) => /^(g|hk|sx)/.test(id)));
  let fitness: Fitness | null = null;
  try {
    const [readings, config, garminPred, shapeSet] = await Promise.all([loadReadings(), loadFitnessConfig(), latestPredictions(), kvGet<Partial<ShapeOptions> | null>("shape.settings", null)]);
    const so: ShapeOptions = { ...SHAPE_DEFAULTS, ...pickShape(shapeSet) };
    const recent = runs.filter((r) => r.date >= "2024-01-01");
    fitness = computeFitness(recent, details, readings, [], config, plan ?? undefined, today, garminPred, so);
  } catch {
    fitness = null;
  }
  const overrides = await loadOverrides().catch(() => new Map<string, string>());
  return { today, plan, planError, runs, details, fitness, overrides };
}

/** Opens the app's code on your copy, runs `f`, and puts back whatever was open before (a sync, say). */
async function withCopy<T>(copy: Copy, f: () => Promise<T>): Promise<T> {
  const prev = getContext();
  setContext({ db: copy.db, files: copy.files, writes: [], creds: copy.creds, saveCreds: async () => {} });
  try {
    return await f();
  } finally {
    setContext(prev);
  }
}

// ---- The tools ---------------------------------------------------------------------------------

const runRow = (w: World, r: Run) => {
  const est = w.fitness?.estimates.find((e) => e.id === r.id);
  return {
    id: r.id,
    date: r.date,
    start: r.start_local,
    name: r.name,
    km: r2(r.distance / 1000),
    moving_time: clock(r.moving_time),
    pace: r.distance > 0 ? pace(r.moving_time / (r.distance / 1000)) : null,
    avg_hr: r.avg_hr ? Math.round(r.avg_hr) : null,
    max_hr: r.max_hr ? Math.round(r.max_hr) : null,
    elevation_m: r.elevation != null ? Math.round(r.elevation) : null,
    race: r.workout_type === 1 || undefined,
    fitness_estimate_vdot: est ? r1(est.vo2 + (w.fitness?.shift ?? 0)) : undefined,
    source: src(r.id),
  };
};

function weekOut(w: World, monday: string) {
  if (!w.plan) return null;
  const fw = forecastWeek(w.plan, monday, w.runs, w.overrides);
  return {
    week_starting: monday,
    plan_week: fw.week ? `${fw.week.week}` : null,
    phase: fw.week?.phase ?? null,
    planned_km: fw.plannedKm,
    done_km: r1(fw.actualKm),
    notes: fw.week?.notes || undefined,
    days: fw.days.map((d) => ({
      date: d.date,
      day: d.dow,
      planned: d.text || "Rest",
      kind: d.kind,
      planned_km: d.km,
      target_pace: d.pace ?? undefined,
      race: d.race ? { name: d.race.name, target: d.race.target || null } : undefined,
      done: d.runs.length ? d.runs.map((r) => ({ id: r.id, name: r.name, km: r2(r.distance / 1000), pace: r.distance ? pace(r.moving_time / (r.distance / 1000)) : null, avg_hr: r.avg_hr ? Math.round(r.avg_hr) : null })) : undefined,
      edited_by_you: d.edited || undefined,
    })),
  };
}

const PREDICT = [
  { name: "5K", m: 5000 },
  { name: "10K", m: 10000 },
  { name: "Half marathon", m: 21097.5 },
  { name: "Marathon", m: 42195 },
];

function predictionsOut(w: World) {
  const f = w.fitness;
  if (!f) return null;
  return f.predictions.map((p) => ({
    distance: p.name,
    predicted: clock(p.seconds),
    predicted_pace: p.seconds ? pace(p.seconds / (p.distance / 1000)) : null,
    shown_source: p.source === "garmin" ? "Garmin's race predictor" : "Pacelife's own model",
    own_model: clock(p.ownSeconds),
    vdot_equivalent: clock(p.vdotSeconds),
    adjusted_for_marathon_shape: clock(p.shapeSeconds),
    garmin: clock(p.garminSeconds),
    a_month_ago: clock(p.monthAgoSeconds ?? p.secondsMonthAgo),
    your_target: p.target ?? undefined,
  }));
}

function weeklyTotals(runs: Run[], fromMonday: string, toMonday: string) {
  const out: { week_starting: string; km: number; runs: number; longest_km: number; time: string | null }[] = [];
  for (let m = fromMonday; m <= toMonday; m = addDays(m, 7)) {
    const e = addDays(m, 6);
    const rs = runs.filter((r) => r.date >= m && r.date <= e);
    out.push({
      week_starting: m,
      km: r1(rs.reduce((a, r) => a + r.distance, 0) / 1000) ?? 0,
      runs: rs.length,
      longest_km: r1(Math.max(0, ...rs.map((r) => r.distance / 1000))) ?? 0,
      time: clock(rs.reduce((a, r) => a + r.moving_time, 0)),
    });
  }
  return out;
}

/** Best times for the standard distances: ever, this year, the last 90 days, and quarter by quarter. */
function bestsOut(w: World) {
  const names = ["400m", "1/2 mile", "1K", "1 mile", "2 mile", "5K", "10K", "15K", "10 mile", "20K", "Half-Marathon", "30K", "Marathon"];
  const byName = new Map<string, { time: number; date: string; id: string }[]>();
  const runById = new Map(w.runs.map((r) => [r.id, r]));
  for (const [id, d] of w.details) {
    const r = runById.get(id);
    if (!r) continue;
    for (const b of d.bestEfforts ?? []) {
      if (!names.includes(b.name) || !(b.time > 0)) continue;
      const a = byName.get(b.name) ?? [];
      a.push({ time: b.time, date: r.date, id });
      byName.set(b.name, a);
    }
  }
  const best = (xs: { time: number; date: string; id: string }[]) => (xs.length ? xs.reduce((a, b) => (b.time < a.time ? b : a)) : null);
  const show = (b: { time: number; date: string; id: string } | null) => (b ? { time: clock(b.time), date: b.date, run_id: b.id } : null);
  const quarter = (d: string) => `${d.slice(0, 4)} Q${Math.floor((+d.slice(5, 7) - 1) / 3) + 1}`;
  return names
    .filter((n) => byName.has(n))
    .map((n) => {
      const xs = byName.get(n)!;
      const qs = new Map<string, { time: number; date: string; id: string }[]>();
      for (const x of xs) qs.set(quarter(x.date), [...(qs.get(quarter(x.date)) ?? []), x]);
      return {
        distance: n,
        all_time: show(best(xs)),
        last_365_days: show(best(xs.filter((x) => x.date >= addDays(w.today, -365)))),
        last_90_days: show(best(xs.filter((x) => x.date >= addDays(w.today, -90)))),
        by_quarter: [...qs].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([q, v]) => ({ quarter: q, best: clock(best(v)!.time) })),
      };
    });
}

type Args = Record<string, unknown>;
const str = (a: Args, k: string) => (typeof a[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a[k] as string) ? (a[k] as string) : null);
const int = (a: Args, k: string, d: number, max: number) => Math.max(1, Math.min(max, Math.floor(Number(a[k] ?? d)) || d));

const TOOLS: { name: string; description: string; inputSchema: object; run: (w: World, a: Args) => unknown }[] = [
  {
    name: "get_overview",
    description:
      "Start here. A summary of the runner right now: current fitness (VDOT) and its trend, predicted race times, training paces, the plan and where they are in it (this week planned vs done), upcoming races and goals, recent volume and training load.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (w) => {
      const f = w.fitness;
      const m0 = mondayOf(w.today);
      const weeks = weeklyTotals(w.runs, addDays(m0, -11 * 7), m0);
      const done = weeks.slice(0, -1);
      const avg = (xs: typeof done) => r1(xs.reduce((a, x) => a + x.km, 0) / Math.max(1, xs.length));
      const v = f?.predictionBasis?.vdot ?? f?.current ?? null;
      return {
        today: w.today,
        fitness: f
          ? {
              vdot_now: r1(f.current != null ? f.current + f.shift : null),
              vdot_used_for_predictions: r1(v),
              basis: f.predictionBasis?.source === "race" ? `a recent race (${f.predictionBasis.race?.name}, ${f.predictionBasis.race?.date})` : f.predictionBasis?.source === "manual" ? "set by you" : "current form from runs",
              change_per_week_last_8_weeks: r2(f.slope),
              needed_per_week_for_next_goal: r2(f.neededSlope),
              next_goal: f.nextMilestone ? { date: f.nextMilestone.date, vdot: r1(f.nextMilestone.vo2 + f.shift), label: f.nextMilestone.label } : null,
              this_week_vs_projection: f.thisWeek.status,
              garmin_vo2max: f.garmin ? { latest: f.garmin.latest.vo2, date: f.garmin.latest.date } : null,
              training_load: f.load,
              marathon_shape: f.shape ?? undefined,
            }
          : null,
        predicted_race_times: predictionsOut(w),
        training_paces: v ? pacesOut(v) : null,
        plan: w.plan
          ? {
              title: w.plan.title,
              built_in_app: w.plan.built ? { goal: w.plan.built.goal ?? "race", race: w.plan.built.raceName, race_date: w.plan.built.raceDate, target: w.plan.built.target || null, level: w.plan.built.level, days_per_week: w.plan.built.days, vdot_at_start: r1(w.plan.built.vdot), vdot_planned_by_race: r1(w.plan.built.vdotEnd) } : null,
              this_week: weekOut(w, m0),
              note: w.planError ?? undefined,
            }
          : { note: w.planError ?? "No plan." },
        upcoming_races: w.plan ? upcomingRaces(w.plan, w.today).slice(0, 6).map((r) => ({ name: r.name, date: r.date, days_to_go: r.days, target: r.target || null, role: r.role || null, priority: r.priority ?? null })) : [],
        volume: { last_4_weeks_avg_km: avg(done.slice(-4)), last_12_weeks_avg_km: avg(done), this_week_km_so_far: weeks[weeks.length - 1].km, total_runs_on_record: w.runs.length, first_run_on_record: w.runs[0]?.date ?? null },
      };
    },
  },
  {
    name: "get_plan",
    description:
      "The training plan week by week: each day's planned session (with its target pace and km), what was actually run that day, the phase and the week's planned vs done km. Also the plan's phases, races, pace zones and rules. Defaults to 2 weeks back and 8 ahead; up to 40 weeks.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day (YYYY-MM-DD); its week is included. Default: two weeks ago." },
        to: { type: "string", description: "Last day (YYYY-MM-DD). Default: eight weeks ahead." },
      },
      additionalProperties: false,
    },
    run: (w, a) => {
      if (!w.plan) return { error: w.planError ?? "No plan." };
      let from = mondayOf(str(a, "from") ?? addDays(w.today, -14));
      const to = mondayOf(str(a, "to") ?? addDays(w.today, 56));
      if ((Date.parse(to) - Date.parse(from)) / (7 * 864e5) > 40) from = addDays(to, -40 * 7);
      const weeks = [];
      for (let m = from; m <= to; m = addDays(m, 7)) weeks.push(weekOut(w, m));
      return {
        title: w.plan.title,
        phases: w.plan.phases,
        races: w.plan.races.map((r) => ({ name: r.name, date: r.date, target: r.target || null, role: r.role || null, priority: r.priority ?? null })),
        pace_zones: w.plan.paces.map((p) => ({ zone: p.zone, pace: p.now, later: p.autumn !== p.now ? p.autumn : undefined, heart_rate: p.hr || undefined, use: p.use })),
        rules: w.plan.rules,
        weeks,
      };
    },
  },
  {
    name: "get_runs",
    description:
      "Runs in a date range, newest first: distance, time, pace, heart rate, elevation, and a fitness estimate (VDOT) for runs with enough data. Default the last 60 days, up to 400 runs.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "YYYY-MM-DD. Default: 60 days ago." },
        to: { type: "string", description: "YYYY-MM-DD. Default: today." },
        limit: { type: "integer", description: "At most this many (default 100, max 400)." },
        min_km: { type: "number", description: "Only runs at least this long." },
      },
      additionalProperties: false,
    },
    run: (w, a) => {
      const from = str(a, "from") ?? addDays(w.today, -60);
      const to = str(a, "to") ?? w.today;
      const min = Number(a.min_km ?? 0) * 1000 || 0;
      const rs = w.runs.filter((r) => r.date >= from && r.date <= to && r.distance >= min).reverse();
      const lim = int(a, "limit", 100, 400);
      return { from, to, count: rs.length, shown: Math.min(lim, rs.length), runs: rs.slice(0, lim).map((r) => runRow(w, r)) };
    },
  },
  {
    name: "get_run",
    description: "One run in detail: kilometre splits (pace, grade-adjusted pace, heart rate, elevation), watch laps (workout reps), best efforts, and what the plan had for that day.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The run's id from get_runs or get_plan." } }, required: ["id"], additionalProperties: false },
    run: (w, a) => {
      const r = w.runs.find((x) => x.id === a.id);
      if (!r) return { error: "No run with that id (runs from Strava's connection aren't available here)." };
      const d = w.details.get(r.id);
      const day = w.plan ? forecastWeek(w.plan, mondayOf(r.date), w.runs, w.overrides).days.find((x) => x.date === r.date) : null;
      return {
        ...runRow(w, r),
        planned_that_day: day ? { session: day.text || "Rest", kind: day.kind, km: day.km, target_pace: day.pace ?? undefined } : null,
        splits: d?.splits.map((s, i) => ({ km: i + 1, distance_m: Math.round(s.distance), pace: s.speed ? pace(1000 / s.speed) : null, grade_adjusted_pace: s.gap ? pace(1000 / s.gap) : null, hr: s.hr ? Math.round(s.hr) : null, elevation_change_m: s.elev != null ? r1(s.elev) : null })),
        laps: d?.laps?.map((l, i) => ({ lap: i + 1, km: r2(l.distance / 1000), time: clock(l.moving_time), pace: l.speed ? pace(1000 / l.speed) : null, hr: l.hr ? Math.round(l.hr) : null })),
        best_efforts: d?.bestEfforts.map((b) => ({ distance: b.name, time: clock(b.time) })),
      };
    },
  },
  {
    name: "get_progress",
    description:
      "How the runner has improved: weekly volume (km, runs, longest run), the fitness (VDOT) trend week by week, aerobic efficiency, training load (acute vs chronic), and best times for standard distances (ever, last year, last 90 days, quarter by quarter). Default 26 weeks, up to 156.",
    inputSchema: { type: "object", properties: { weeks: { type: "integer", description: "How many weeks back (default 26, max 156)." } }, additionalProperties: false },
    run: (w, a) => {
      const n = int(a, "weeks", 26, 156);
      const m0 = mondayOf(w.today);
      const from = addDays(m0, -(n - 1) * 7);
      const f = w.fitness;
      const fit = f ? new Map(f.weekly.map((p) => [p.week, p])) : new Map();
      return {
        weeks: weeklyTotals(w.runs, from, m0).map((x) => {
          const p = fit.get(x.week_starting);
          return { ...x, fitness_vdot: p?.smooth != null ? r1(p.smooth + (f?.shift ?? 0)) : null };
        }),
        aerobic_efficiency: f?.efficiency.filter((e) => e.week >= from && e.value != null).map((e) => ({ week_starting: e.week, value: r2(e.value) })),
        training_load_weekly: f?.loadSeries.filter((p, i, xs) => p.date >= from && (i === xs.length - 1 || new Date(p.date + "T12:00").getDay() === 0)).map((p) => ({ date: p.date, acute: r1(p.acute), chronic: r1(p.chronic) })),
        best_times: bestsOut(w),
        races: f?.races.map((r) => ({ date: r.date, name: r.name, vdot: r1(r.vdot) })),
      };
    },
  },
  {
    name: "get_projections",
    description:
      "Predicted race times and paces now, how they've moved over the last month, the speed–endurance model behind them, and for each upcoming race: the projected fitness on race day (if the plan's trend holds), the time that projects to, and the goal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (w) => {
      const f = w.fitness;
      if (!f) return { error: "Not enough runs with heart rate to work out fitness yet." };
      const v = f.predictionBasis?.vdot ?? f.current;
      const races = w.plan
        ? upcomingRaces(w.plan, w.today)
            .filter((r) => r.date)
            .slice(0, 5)
            .map((r) => {
              const km = r.km ?? raceKm(r.name);
              const vRace = f.project(r.date!);
              const vNow = v;
              return {
                name: r.name,
                date: r.date,
                distance_km: km,
                goal: r.target || null,
                predicted_if_raced_today: km && vNow ? clock(predictTime(km * 1000, vNow)) : null,
                projected_vdot_on_race_day: r1(vRace != null ? vRace + f.shift : null),
                projected_time_on_race_day: km && vRace ? clock(predictTime(km * 1000, vRace)) : null,
                race_pace_now: km && vNow ? pace(predictTime(km * 1000, vNow) / km) : null,
              };
            })
        : [];
      const vEnd = w.plan?.built?.vdotEnd;
      return {
        vdot_used: r1(v),
        basis: f.predictionBasis,
        predictions: predictionsOut(w),
        endurance_model: f.endurance ? { exponent_k: r2(f.endurance.k), ten_k_anchor: clock(f.endurance.ten), anchor: f.endurance.anchor, fitted_from_your_races: f.endurance.fitted } : null,
        paces_now: v ? pacesOut(v) : null,
        paces_at_plan_goal: vEnd ? pacesOut(vEnd) : null,
        races,
        standard_times_at_current_vdot: v ? PREDICT.map((p) => ({ distance: p.name, time: clock(predictTime(p.m, v)) })) : null,
      };
    },
  },
];

const INSTRUCTIONS =
  "Pacelife holds this runner's training plan and runs. Call get_overview first, then get_progress for improvement over time, get_plan for the plan (planned vs done), get_runs and get_run for specific runs, and get_projections for predicted times and paces. VDOT is Jack Daniels' running-fitness number; paces are min:sec per km. Read-only. Runs from Strava's API connection are not included.";

// ---- The protocol ----------------------------------------------------------------------------

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** One MCP request over HTTP (JSON responses, no streaming). `open` gives a fresh copy of your data. */
export async function mcpResponse(req: Request, open: () => Promise<Copy>, today: string): Promise<Response> {
  const headers = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" };
  if (req.method === "GET") return new Response("This is a Pacelife connector for Claude: add this address in Claude (Settings → Connectors → Add custom connector).", { status: 405, headers: { allow: "POST", "content-type": "text/plain" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let body: Rpc | Rpc[];
  try {
    body = (await req.json()) as Rpc | Rpc[];
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), { status: 400, headers });
  }
  const list = Array.isArray(body) ? body : [body];
  let copy: Copy | null = null;
  let world: World | null = null;
  const out: unknown[] = [];
  try {
    for (const m of list) {
      if (m.id === undefined || m.id === null) continue; // notifications: nothing to answer
      const reply = (result: unknown) => out.push({ jsonrpc: "2.0", id: m.id, result });
      const fail = (code: number, message: string) => out.push({ jsonrpc: "2.0", id: m.id, error: { code, message } });
      switch (m.method) {
        case "initialize": {
          const asked = String(m.params?.protocolVersion ?? "");
          reply({ protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Pacelife", title: "Pacelife", version: "1.0.0" }, instructions: INSTRUCTIONS });
          break;
        }
        case "ping":
        case "logging/setLevel":
          reply({});
          break;
        // Not offered, but some clients ask anyway: empty lists rather than errors.
        case "resources/list":
          reply({ resources: [] });
          break;
        case "resources/templates/list":
          reply({ resourceTemplates: [] });
          break;
        case "prompts/list":
          reply({ prompts: [] });
          break;
        case "completion/complete":
          reply({ completion: { values: [] } });
          break;
        case "tools/list":
          reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
          break;
        case "tools/call": {
          const t = TOOLS.find((x) => x.name === m.params?.name);
          if (!t) {
            fail(-32602, `Unknown tool: ${String(m.params?.name)}`);
            break;
          }
          try {
            copy ??= await open();
            const c = copy;
            const result = await withCopy(c, async () => {
              world ??= await readWorld(today);
              return t.run(world, (m.params?.arguments as Args) ?? {});
            });
            reply({ content: [{ type: "text", text: JSON.stringify(result) }], isError: !!(result && typeof result === "object" && "error" in result) });
          } catch (e) {
            reply({ content: [{ type: "text", text: `Couldn't read your Pacelife data: ${(e as Error)?.message ?? e}` }], isError: true });
          }
          break;
        }
        default:
          fail(-32601, `Method not found: ${String(m.method)}`);
      }
    }
  } finally {
    copy?.db.close();
  }
  if (!out.length) return new Response(null, { status: 202 });
  // A session id on the first answer (the link is the key; the id only keeps clients that expect one happy).
  const session: Record<string, string> = list.some((m) => m.method === "initialize") ? { "mcp-session-id": crypto.randomUUID() } : {};
  return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { ...headers, ...session } });
}
