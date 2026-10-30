import { backend } from "@backend";
import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { addDays, diffDays, todayKey } from "../../core/time";

/**
 * Daily health numbers from Garmin Connect, cached locally so the dashboard
 * works offline. Garmin's replies aren't documented, so every field is read
 * defensively and a missing one just stays empty.
 */

export const migrations = [
  `CREATE TABLE health_daily (
     date TEXT PRIMARY KEY,
     vo2 REAL,
     hrv REAL,
     hrv_week REAL,
     hrv_status TEXT,
     hrv_low REAL,
     hrv_high REAL,
     rhr REAL,
     sleep_secs REAL,
     sleep_score REAL,
     bb_high REAL,
     bb_low REAL,
     bb_now REAL,
     readiness REAL,
     readiness_level TEXT,
     readiness_note TEXT,
     pred_5k REAL,
     pred_10k REAL,
     pred_half REAL,
     pred_marathon REAL,
     updated_at TEXT NOT NULL
   );`,
  // 1 — when last night's sleep ended, so it's clear which night is shown
  `ALTER TABLE health_daily ADD COLUMN sleep_end TEXT;`,
];

export interface HealthDay {
  date: string;
  vo2: number | null;
  hrv: number | null;
  hrv_week: number | null;
  hrv_status: string | null;
  hrv_low: number | null;
  hrv_high: number | null;
  rhr: number | null;
  sleep_secs: number | null;
  sleep_score: number | null;
  bb_high: number | null;
  bb_low: number | null;
  bb_now: number | null;
  readiness: number | null;
  readiness_level: string | null;
  readiness_note: string | null;
  sleep_end: string | null;
  pred_5k: number | null;
  pred_10k: number | null;
  pred_half: number | null;
  pred_marathon: number | null;
}

type Field = Exclude<keyof HealthDay, "date">;
const FIELDS: Field[] = [
  "vo2",
  "hrv",
  "hrv_week",
  "hrv_status",
  "hrv_low",
  "hrv_high",
  "rhr",
  "sleep_secs",
  "sleep_score",
  "bb_high",
  "bb_low",
  "bb_now",
  "readiness",
  "readiness_level",
  "readiness_note",
  "sleep_end",
  "pred_5k",
  "pred_10k",
  "pred_half",
  "pred_marathon",
];

export interface HealthSync {
  lastSync: string | null;
  offline: boolean;
  /** Per-metric problems, so one failing endpoint doesn't hide the rest. */
  errors: string[];
  /** Which metrics returned data last time (for the diagnostics line). */
  got: string[];
}

export const getHealthSync = () => kvGet<HealthSync>("health.sync", { lastSync: null, offline: false, errors: [], got: [] });

// ---- Tolerant field access -------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** First number under a key matching `re`, searching a few levels deep. */
export function pickNum(o: unknown, re: RegExp, depth = 3): number | null {
  if (!isObj(o) || depth < 0) return null;
  for (const [k, v] of Object.entries(o)) if (re.test(k) && typeof v === "number" && Number.isFinite(v)) return v;
  for (const v of Object.values(o)) {
    const n = isObj(v) ? pickNum(v, re, depth - 1) : null;
    if (n != null) return n;
  }
  return null;
}

export function pickStr(o: unknown, re: RegExp, depth = 2): string | null {
  if (!isObj(o) || depth < 0) return null;
  for (const [k, v] of Object.entries(o)) if (re.test(k) && typeof v === "string") return v;
  for (const v of Object.values(o)) {
    const s = isObj(v) ? pickStr(v, re, depth - 1) : null;
    if (s != null) return s;
  }
  return null;
}

const dateOf = (o: unknown): string | null => {
  const s = pickStr(o, /^(calendarDate|date)$/i, 2);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : isObj(v) ? [v] : []);

// ---- Parsers (pure, unit-tested) ---------------------------------------------------

export type Patch = Map<string, Partial<Record<Field, number | string | null>>>;
const put = (p: Patch, date: string | null, f: Partial<Record<Field, number | string | null>>) => {
  if (!date) return;
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v != null));
  if (Object.keys(clean).length) p.set(date, { ...(p.get(date) ?? {}), ...clean });
};

export function parseVo2(body: unknown, p: Patch) {
  for (const row of asList(body)) {
    const g = isObj(row) && isObj(row.generic) ? row.generic : row;
    put(p, dateOf(g) ?? dateOf(row), { vo2: pickNum(g, /^vo2MaxPreciseValue$/i) ?? pickNum(g, /^vo2MaxValue$/i) });
  }
}

export function parseHrv(body: unknown, p: Patch) {
  const list = isObj(body) && Array.isArray(body.hrvSummaries) ? body.hrvSummaries : isObj(body) && isObj(body.hrvSummary) ? [body.hrvSummary] : asList(body);
  for (const row of list) {
    put(p, dateOf(row), {
      hrv: pickNum(row, /^lastNightAvg$/i),
      hrv_week: pickNum(row, /^weeklyAvg$/i),
      hrv_status: pickStr(row, /^status$/i, 0),
      hrv_low: pickNum(row, /^balancedLow$/i),
      hrv_high: pickNum(row, /^balancedUpper$/i),
    });
  }
}

export function parseRhr(body: unknown, p: Patch) {
  const rows = isObj(body) && isObj(body.allMetrics) && isObj(body.allMetrics.metricsMap) ? body.allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE : body;
  for (const row of asList(rows)) put(p, dateOf(row), { rhr: pickNum(row, /^(value|restingHeartRate)$/i) });
}

export function parseSleep(body: unknown, p: Patch) {
  const rows = isObj(body) && Array.isArray(body.individualStats) ? body.individualStats : asList(body);
  for (const row of rows) {
    const secs = pickNum(row, /^(totalSleepTimeInSeconds|sleepTimeSeconds|totalSleepSeconds|sleepTimeInSeconds)$/i);
    put(p, dateOf(row), {
      sleep_secs: secs,
      sleep_score: pickNum(row, /^(overallSleepScore|sleepScore|overall)$/i) ?? pickNum(row, /sleepScore/i),
    });
  }
}

/**
 * One night in full (wellness-service dailySleepData). The daily stats list
 * only fills in later in the day, so last night comes from here.
 */
export function parseDailySleep(body: unknown, p: Patch) {
  const dto = isObj(body) && isObj(body.dailySleepDTO) ? body.dailySleepDTO : null;
  if (!dto) return;
  const scores = isObj(dto.sleepScores) ? dto.sleepScores : null;
  const overall = scores && isObj(scores.overall) ? scores.overall : null;
  const secs = pickNum(dto, /^sleepTimeSeconds$/i, 0);
  if (!secs) return; // an empty record for a night that hasn't been synced yet
  // Garmin's "local" timestamps are local wall-clock time written as if it were UTC.
  const endLocal = pickNum(dto, /^sleepEndTimestampLocal$/i, 0);
  const end = endLocal ? new Date(endLocal).toISOString() : null;
  put(p, end ? end.slice(0, 10) : dateOf(dto), {
    sleep_secs: secs,
    sleep_score: (overall && pickNum(overall, /^value$/i, 0)) ?? pickNum(dto, /^(overallSleepScore|sleepScore)$/i, 1),
    sleep_end: end ? end.slice(11, 16) : null,
  });
}

export function parseBodyBattery(body: unknown, p: Patch, today: string) {
  for (const row of asList(body)) {
    const arr = isObj(row) && Array.isArray(row.bodyBatteryValuesArray) ? (row.bodyBatteryValuesArray as unknown[]) : [];
    const vals = arr.map((x) => (Array.isArray(x) ? x[1] : null)).filter((x): x is number => typeof x === "number");
    const date = dateOf(row);
    put(p, date, {
      bb_high: vals.length ? Math.max(...vals) : null,
      bb_low: vals.length ? Math.min(...vals) : null,
      bb_now: date === today && vals.length ? vals[vals.length - 1] : null,
    });
  }
}

export function parseReadiness(body: unknown, p: Patch) {
  // Several entries a day (after waking, after activities): the latest wins.
  const rows = asList(body).filter(isObj);
  rows.sort((a, b) => String(a.timestampLocal ?? a.timestamp ?? "").localeCompare(String(b.timestampLocal ?? b.timestamp ?? "")));
  for (const row of rows) {
    const rec = pickNum(row, /^recoveryTime$/i, 0); // minutes
    put(p, dateOf(row), {
      readiness: pickNum(row, /^score$/i, 0),
      readiness_level: pickStr(row, /^level$/i, 0),
      readiness_note: rec != null && rec > 0 ? `Recovery ${Math.round(rec / 60)} h` : pickStr(row, /^feedbackShort$/i, 0),
    });
  }
}

export function parsePredictions(body: unknown, p: Patch, fallbackDate: string) {
  for (const row of asList(body)) {
    put(p, dateOf(row) ?? fallbackDate, {
      pred_5k: pickNum(row, /^time5k$/i, 1),
      pred_10k: pickNum(row, /^time10k$/i, 1),
      pred_half: pickNum(row, /^timeHalfMarathon$/i, 1),
      pred_marathon: pickNum(row, /^timeMarathon$/i, 1),
    });
  }
}

// ---- Sync ------------------------------------------------------------------------

async function get(path: string): Promise<unknown> {
  const r = await backend.garminRequest(path);
  if (r.status === 204 || r.status === 404) return null;
  if (r.status === 403) throw new Error("Garmin refused this (403)");
  if (r.status !== 200) throw new Error(`Garmin answered ${r.status}`);
  return r.body;
}

function chunks(from: string, to: string, days: number): [string, string][] {
  const out: [string, string][] = [];
  for (let a = from; a <= to; a = addDays(a, days)) {
    const b = addDays(a, days - 1);
    out.push([a, b > to ? to : b]);
  }
  return out;
}

let running: Promise<HealthSync> | null = null;

/** Pulls recent days from Garmin: 4 months the first time, then the last week. */
export function syncHealth(): Promise<HealthSync> {
  running ??= doSync().finally(() => (running = null));
  return running;
}

async function doSync(): Promise<HealthSync> {
  const status = await backend.garminStatus().catch(() => ({ connected: false }));
  if (!status.connected) return getHealthSync();
  const prev = await getHealthSync();
  const today = todayKey();
  const from = prev.lastSync && diffDays(prev.lastSync.slice(0, 10), today) < 30 ? addDays(today, -7) : addDays(today, -120);
  const patch: Patch = new Map();
  const errors: string[] = [];
  const got: string[] = [];
  let offline = false;
  const step = async (name: string, fn: () => Promise<void>) => {
    const before = patch.size;
    try {
      await fn();
      if (patch.size >= before) got.push(name);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.startsWith("offline")) offline = true;
      else errors.push(`${name}: ${msg}`);
    }
  };

  let name = await kvGet<string | null>("health.displayName", null);
  await step("profile", async () => {
    const prof = await get("/userprofile-service/socialProfile");
    const dn = pickStr(prof, /^displayName$/i, 0);
    if (dn) {
      name = dn;
      await kvSet("health.displayName", dn);
    }
  });
  if (offline) {
    const s = { ...prev, offline: true };
    await kvSet("health.sync", s);
    return s;
  }

  await step("VO2 max", async () => {
    for (const [a, b] of chunks(from, today, 60)) parseVo2(await get(`/metrics-service/metrics/maxmet/daily/${a}/${b}`), patch);
  });
  await step("HRV", async () => {
    for (const [a, b] of chunks(from, today, 28)) parseHrv(await get(`/hrv-service/hrv/daily/${a}/${b}`), patch);
    // Last night on its own: the range list can lag behind by a day.
    parseHrv(await get(`/hrv-service/hrv/${today}`), patch);
  });
  // Sleep: the full record for each of the last three nights (dated by the morning you woke),
  // then the daily stats list for older nights. The stats list can lag a day behind and may be
  // dated by the evening the night started, so it's lined up against the full records first.
  const nights: Patch = new Map();
  const sleepDebug: { asked: string; via: string; wake: string | null; secs: number | null }[] = [];
  await step("last night's sleep", async () => {
    for (const d of [addDays(today, -2), addDays(today, -1), today]) {
      let body: unknown = null;
      let via = "sleep-service";
      try {
        body = await get(`/sleep-service/sleep/dailySleepData?date=${d}&nonSleepBufferMinutes=60`);
      } catch {
        body = null;
      }
      if (!isObj(body) || !isObj(body.dailySleepDTO) || !pickNum(body.dailySleepDTO, /^sleepTimeSeconds$/i, 0)) {
        via = "wellness-service";
        body = name ? await get(`/wellness-service/wellness/dailySleepData/${encodeURIComponent(name)}?date=${d}&nonSleepBufferMinutes=60`) : null;
      }
      const before = new Set(nights.keys());
      parseDailySleep(body, nights);
      const added = [...nights.keys()].find((k) => !before.has(k)) ?? null;
      sleepDebug.push({ asked: d, via, wake: added, secs: added ? (nights.get(added)?.sleep_secs as number) ?? null : null });
    }
  });
  await kvSet("health.sleepDebug", sleepDebug);
  await step("sleep history", async () => {
    const stats: Patch = new Map();
    for (const [a, b] of chunks(from, today, 28)) parseSleep(await get(`/sleep-service/stats/sleep/daily/${a}/${b}`), stats);
    // Line the list up with the full records: same night, same length.
    let shift = 0;
    for (const [date, n] of nights) {
      if (stats.get(date)?.sleep_secs === n.sleep_secs) break;
      if (stats.get(addDays(date, -1))?.sleep_secs === n.sleep_secs) {
        shift = 1;
        break;
      }
    }
    for (const [date, f] of stats) {
      const d = addDays(date, shift);
      if (!nights.has(d) && d <= today) put(patch, d, f);
    }
  });
  for (const [d, f] of nights) put(patch, d, f);
  await step("Body Battery", async () => {
    for (const [a, b] of chunks(from, today, 28)) parseBodyBattery(await get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${a}&endDate=${b}`), patch, today);
  });
  await step("training readiness", async () => parseReadiness(await get(`/metrics-service/metrics/trainingreadiness/${today}`), patch));
  if (name) {
    const dn = encodeURIComponent(name);
    await step("resting HR", async () => parseRhr(await get(`/userstats-service/wellness/daily/${dn}?fromDate=${from}&untilDate=${today}&metricId=60`), patch));
    await step("race predictions", async () => {
      parsePredictions(await get(`/metrics-service/metrics/racepredictions/daily/${dn}?fromCalendarDate=${from}&toCalendarDate=${today}`), patch, today);
      parsePredictions(await get(`/metrics-service/metrics/racepredictions/latest/${dn}`), patch, today);
    });
  } else errors.push("resting HR and race predictions: couldn't read your Garmin profile name");

  const stamp = new Date().toISOString();
  const stmts = [...patch.entries()].map(([date, f]) => {
    const keys = Object.keys(f) as Field[];
    return {
      sql: `INSERT INTO health_daily (date, ${keys.join(", ")}, updated_at) VALUES (?, ${keys.map(() => "?").join(", ")}, ?)
            ON CONFLICT(date) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}, updated_at = excluded.updated_at`,
      params: [date, ...keys.map((k) => f[k] as number | string), stamp],
    };
  });
  // Garmin's VO2 max also feeds the Fitness page's Garmin comparison: one reading per change.
  const vo2 = [...patch.entries()].filter(([, f]) => typeof f.vo2 === "number").sort(([a], [b]) => a.localeCompare(b));
  let lastVo2 = (await db.select<{ vo2: number }>("SELECT vo2 FROM vo2_readings WHERE date < ? ORDER BY date DESC LIMIT 1", [vo2[0]?.[0] ?? today]))[0]?.vo2 ?? null;
  for (const [i, [date, f]] of vo2.entries()) {
    // One reading per change, plus the latest day so the Fitness page knows it's current.
    if (f.vo2 !== lastVo2 || i === vo2.length - 1) stmts.push({ sql: "INSERT OR REPLACE INTO vo2_readings (date, vo2, source) VALUES (?, ?, 'garmin-sync')", params: [date, f.vo2 as number] });
    lastVo2 = f.vo2 as number;
  }
  if (stmts.length) await db.batch(stmts);
  const state: HealthSync = { lastSync: errors.length && !patch.size ? prev.lastSync : stamp, offline: false, errors, got };
  await kvSet("health.sync", state);
  await notifyChanged("health");
  if (vo2.length) await notifyChanged("running");
  return state;
}

export async function loadHealth(days = 120): Promise<HealthDay[]> {
  return db.select<HealthDay>(`SELECT date, ${FIELDS.join(", ")} FROM health_daily WHERE date >= ? ORDER BY date`, [addDays(todayKey(), -days)]);
}

/** The most recent value of each field (they come in on different days). */
export function latest(rows: HealthDay[]): Partial<HealthDay> & { dates: Partial<Record<Field, string>> } {
  const out: Partial<HealthDay> & { dates: Partial<Record<Field, string>> } = { dates: {} };
  for (const r of rows)
    for (const f of FIELDS)
      if (r[f] != null) {
        (out as Record<string, unknown>)[f] = r[f];
        out.dates[f] = r.date;
      }
  return out;
}

/** Garmin's latest race predictions, and the ones from about a month before, for the Fitness page. */
export async function latestPredictions(): Promise<{ values: Record<string, number>; date: string; monthAgo: Record<string, number> | null } | null> {
  type Row = { date: string; pred_5k: number | null; pred_10k: number | null; pred_half: number | null; pred_marathon: number | null };
  const q = (where: string, params: string[]) =>
    db.select<Row>(`SELECT date, pred_5k, pred_10k, pred_half, pred_marathon FROM health_daily WHERE pred_10k IS NOT NULL ${where} ORDER BY date DESC LIMIT 1`, params).catch(() => [] as Row[]);
  const r = (await q("", []))[0];
  if (!r) return null;
  const old = (await q("AND date <= ?", [addDays(r.date, -30)]))[0];
  const vals = (x: Row) => {
    const v: Record<string, number> = {};
    if (x.pred_5k) v["5k"] = x.pred_5k;
    if (x.pred_10k) v["10k"] = x.pred_10k;
    if (x.pred_half) v["Half"] = x.pred_half;
    if (x.pred_marathon) v["Marathon"] = x.pred_marathon;
    return v;
  };
  return { values: vals(r), date: r.date, monthAgo: old && old.date >= addDays(r.date, -45) ? vals(old) : null };
}
