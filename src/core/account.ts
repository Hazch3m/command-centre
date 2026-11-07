/**
 * Accounts: Pacelife without a PC. Signing in with Apple on the iPhone
 * app gives each person their own private store on the sync service, which
 * keeps their data and fetches from Garmin itself. A PC can join the account
 * later with a code from the phone.
 *
 * A new account starts with an empty database (the same tables the PC makes)
 * and no training plan; you build one in the app.
 */
import { migrations as runningMigrations } from "../modules/running/strava";
import { migrations as calendarMigrations } from "../modules/calendar/data";
import { migrations as healthMigrations } from "../modules/health/data";
import { migrations as taskMigrations } from "../modules/tasks/data";
import { syncMigrations as taskSyncMigrations } from "../modules/tasks/gsync";
import { migrations as checklistMigrations } from "../modules/checklist/data";
import type { SnapshotHeader } from "./sync";

/** The tables, in the PC's order and with its migration ids (so a PC could take the database over). */
export const ACCOUNT_SCHEMA: { id: string; migrations: string[] }[] = [
  { id: "running", migrations: runningMigrations },
  { id: "calendar", migrations: calendarMigrations },
  { id: "health", migrations: healthMigrations },
  { id: "tasks", migrations: [...taskMigrations, ...taskSyncMigrations] },
  { id: "checklist", migrations: checklistMigrations },
];

/** Just enough of sql.js (or anything like it) to build the database. */
interface MiniDb {
  exec(sql: string): unknown;
  run(sql: string, params?: (string | number | null)[]): unknown;
  export(): Uint8Array;
}

export function buildAccountDb(d: MiniDb): Uint8Array {
  d.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);`);
  const now = new Date().toISOString();
  for (const m of ACCOUNT_SCHEMA)
    m.migrations.forEach((sql, i) => {
      d.exec(sql);
      d.run("INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", [`${m.id}:${i}`, now]);
    });
  return d.export();
}

/** An empty plan: the app asks you to build one. */
export const EMPTY_PLAN = {
  version: 1,
  title: "No plan yet",
  exported: "",
  source: "",
  editedInApp: "new account",
  phases: [],
  blocks: [],
  races: [],
  weeks: [],
  paces: [],
  structure: [],
  strength: { A: [], B: [] },
  rules: [],
  benchmarks: [],
  history: { races: [], marathons: [] },
};

/** Fitness settings until you set your own (or Garmin's heart-rate numbers arrive). */
export function starterFitness(today: string) {
  return { hrMax: 190, hrRest: 55, calibrate: true, auto: true, projection: { start: { date: today, vo2: null }, milestones: [] } };
}

export function accountHeader(today: string): SnapshotHeader {
  return {
    v: 1,
    made: new Date().toISOString(),
    files: { "training-plan.json": JSON.stringify(EMPTY_PLAN, null, 2), "fitness.json": JSON.stringify(starterFitness(today), null, 2) },
    connected: { strava: false, google: false, garmin: false },
    ics: [],
    applied: 0,
    cloudApplied: 0,
    cloud: true,
  };
}

/** A plan with nothing in it yet (a new account's). */
export const isEmptyPlan = (p: { weeks: unknown[] } | null | undefined) => !!p && p.weeks.length === 0;
