/**
 * Development harness only: a stand-in for the user's garmin-coach MCP server in
 * the browser preview. Same tool names and input schemas as the real server
 * (copied from its tool list), the same validation messages for durations and
 * targets, and a calendar kept in localStorage. Never part of the installed app.
 */
import type { McpCallResult, McpTool, WatchStatus } from "./backend.types";

const STEPS_HELP = "\nsteps is a list. Each item is either a step or a repeat: …";
const stepsProp = { items: { additionalProperties: true, type: "object" }, title: "Steps", type: "array" };
const optStr = (title: string) => ({ anyOf: [{ type: "string" }, { type: "null" }], default: null, title });

export const FAKE_TOOLS: McpTool[] = [
  { name: "preview_workout", description: "Check a workout and return a readable summary WITHOUT touching Garmin." + STEPS_HELP, inputSchema: { type: "object", properties: { name: { type: "string" }, steps: stepsProp, sport: { type: "string", default: "running" }, description: optStr("Description") }, required: ["name", "steps"] } },
  { name: "create_workout", description: "Save a structured workout to Garmin Connect." + STEPS_HELP, inputSchema: { type: "object", properties: { name: { type: "string" }, steps: stepsProp, sport: { type: "string", default: "running" }, description: optStr("Description"), date: optStr("Date") }, required: ["name", "steps"] } },
  { name: "update_workout", description: "Replace an existing Garmin workout's content." + STEPS_HELP, inputSchema: { type: "object", properties: { workout_id: { type: "integer" }, name: { type: "string" }, steps: stepsProp, sport: { type: "string", default: "running" }, description: optStr("Description") }, required: ["workout_id", "name", "steps"] } },
  { name: "schedule_workout", description: "Put an existing workout on the Garmin calendar.", inputSchema: { type: "object", properties: { workout_id: { type: "integer" }, date: { type: "string" } }, required: ["workout_id", "date"] } },
  { name: "list_workouts", description: "List workouts saved in Garmin Connect, newest first.", inputSchema: { type: "object", properties: { limit: { type: "integer", default: 30 } } } },
  { name: "get_workout", description: "Show the steps of a saved workout in readable form.", inputSchema: { type: "object", properties: { workout_id: { type: "integer" } }, required: ["workout_id"] } },
  { name: "get_scheduled", description: "List workouts on the Garmin calendar between two dates.", inputSchema: { type: "object", properties: { start_date: { type: "string" }, end_date: { type: "string" } }, required: ["start_date", "end_date"] } },
  { name: "unschedule_workout", description: "Remove one calendar entry.", inputSchema: { type: "object", properties: { schedule_id: { type: "integer" } }, required: ["schedule_id"] } },
  { name: "delete_workout", description: "Delete a saved workout from Garmin Connect.", inputSchema: { type: "object", properties: { workout_id: { type: "integer" } }, required: ["workout_id"] } },
];

type Raw = Record<string, unknown>;
interface Store {
  workouts: Record<string, { name: string; summary: string }>;
  schedule: { scheduleId: number; workoutId: number; date: string }[];
  seq: number;
}
const KEY = "cc-fake-garmin-coach";
const load = (seed: Store): Store => JSON.parse(localStorage.getItem(KEY) ?? "null") ?? seed;
const save = (s: Store) => localStorage.setItem(KEY, JSON.stringify(s));

class WorkoutError extends Error {}
const KINDS = ["warmup", "interval", "recovery", "rest", "cooldown", "other", "repeat"];

function duration(text: unknown): string {
  const t = String(text ?? "").trim().toLowerCase().replace(/ /g, "");
  if (!t || t === "lap" || t === "open") return "until lap press";
  let m = /^(\d+(?:\.\d+)?)(m|km|mi)$/.exec(t);
  if (m) return m[2] === "m" ? `${+m[1]} m` : `${+m[1]} ${m[2]}`;
  m = /^(\d+(?:\.\d+)?)(s|sec|min)$/.exec(t);
  if (m) return m[2] === "min" ? `${m[1]}:00` : `0:${String(+m[1]).padStart(2, "0")}`;
  if (/^\d+(:\d{1,2}){0,2}$/.test(t)) return t.includes(":") ? t : `${t}:00`;
  throw new WorkoutError(`Can't read duration '${text}'. Use '10:00', '90s', '800m', '5km', '2mi' or 'lap'.`);
}
function target(text: unknown): string {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || ["open", "none", "no target"].includes(t)) return "no target";
  if (/^pace\s+\d+:\d{2}(?:\s*-\s*\d+:\d{2})?\s*(?:\/\s*(km|mi|mile))?$/.test(t)) return t.includes("/") ? t.replace(/\s+/g, " ") : `${t}/km`;
  if (/^(hr|heart rate)\s+zone\s+[1-5]$/.test(t)) return t.replace("heart rate", "hr");
  if (/^power\s+zone\s+[1-7]$/.test(t)) return t;
  if (/^(hr|heart rate|cadence|power)\s+\d+\s*-\s*\d+/.test(t)) return t;
  throw new WorkoutError(`Can't read target '${text}'. Use 'open', 'pace 4:50-5:05/km', 'pace 7:45/mi', 'hr zone 2', 'hr 140-150', 'cadence 170-180', 'power 250-280' or 'power zone 3'.`);
}
function walk(steps: unknown, indent: string, out: string[]) {
  if (!Array.isArray(steps) || !steps.length) throw new WorkoutError("Each workout (and each repeat) needs a non-empty list of steps.");
  steps.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") throw new WorkoutError(`Step ${i + 1} must be an object.`);
    const s = raw as Raw;
    const kind = String(s.kind ?? "").toLowerCase();
    if (!KINDS.includes(kind)) throw new WorkoutError(`Step ${i + 1}: kind '${kind}' unknown. Use one of ${KINDS.join(", ")}.`);
    if (kind === "repeat") {
      if (!Number.isInteger(s.times) || (s.times as number) < 1) throw new WorkoutError(`Step ${i + 1}: a repeat needs 'times' as a whole number >= 1.`);
      out.push(`${indent}Repeat x${s.times}:`);
      walk(s.steps, indent + "  ", out);
      return;
    }
    out.push(`${indent}${kind}: ${duration(s.duration)}, ${target(s.target)}${s.notes ? ` — ${s.notes}` : ""}`);
  });
}
function describe(args: Raw): string {
  if (!String(args.name ?? "").trim()) throw new WorkoutError("Workout needs a name.");
  const out = [`${args.name} (${args.sport ?? "running"})`];
  walk(args.steps, "  ", out);
  return out.join("\n");
}

const text = (t: string, structured?: unknown): McpCallResult => ({ content: [{ type: "text", text: t }], structuredContent: structured ?? { result: t } });
const json = (v: unknown): McpCallResult =>
  Array.isArray(v) ? { content: v.map((x) => ({ type: "text", text: JSON.stringify(x) })), structuredContent: { result: v } } : { content: [{ type: "text", text: JSON.stringify(v) }], structuredContent: v };
const fail = (tool: string, msg: string): McpCallResult => ({ content: [{ type: "text", text: `Error executing tool ${tool}: ${msg}` }], isError: true });

export function fakeStatus(ok: boolean): WatchStatus {
  return {
    folder: "C:\\Users\\you\\Downloads\\garmin-coach-mcp\\garmin-coach-mcp",
    serverFound: ok,
    python: ok ? "C:\\Users\\you\\Downloads\\garmin-coach-mcp\\garmin-coach-mcp\\.venv\\Scripts\\python.exe" : null,
    tokensFound: ok && localStorage.getItem("cc-fake-gc-login") !== "expired",
    tokensDir: "C:\\Users\\you\\.garminconnect",
    running: ok,
    stderr: [],
  };
}

export function fakeCall(name: string, args: Raw, seed: Store): McpCallResult {
  const st = load(seed);
  const login = localStorage.getItem("cc-fake-gc-login") === "expired";
  if (login && name !== "preview_workout") return fail(name, "Garmin Connect GET /calendar-service failed: 401 Client Error: Unauthorized");
  try {
    switch (name) {
      case "preview_workout":
        try {
          return text(describe(args));
        } catch (e) {
          if (e instanceof WorkoutError) return text(`Invalid workout: ${e.message}`);
          throw e;
        }
      case "create_workout": {
        let summary: string;
        try {
          summary = describe(args);
        } catch (e) {
          return json({ ok: false, error: (e as Error).message });
        }
        const workoutId = 1_800_000_000 + ++st.seq;
        st.workouts[workoutId] = { name: String(args.name), summary };
        const out: Raw = { ok: true, workoutId, summary };
        if (args.date) {
          const scheduleId = 1_900_000_000 + ++st.seq;
          st.schedule.push({ scheduleId, workoutId, date: String(args.date) });
          Object.assign(out, { scheduledDate: args.date, scheduleId, note: "On the Garmin calendar; it reaches the watch on its next sync." });
        }
        save(st);
        return json(out);
      }
      case "update_workout": {
        let summary: string;
        try {
          summary = describe(args);
        } catch (e) {
          return json({ ok: false, error: (e as Error).message });
        }
        st.workouts[String(args.workout_id)] = { name: String(args.name), summary };
        save(st);
        return json({ ok: true, workoutId: args.workout_id, summary });
      }
      case "schedule_workout": {
        const scheduleId = 1_900_000_000 + ++st.seq;
        st.schedule.push({ scheduleId, workoutId: Number(args.workout_id), date: String(args.date) });
        save(st);
        return json({ ok: true, workoutId: args.workout_id, date: args.date, scheduleId });
      }
      case "get_scheduled": {
        const a = String(args.start_date);
        const b = String(args.end_date);
        const items = st.schedule
          .filter((s) => s.date >= a && s.date <= b)
          .sort((x, y) => x.date.localeCompare(y.date))
          .map((s) => ({ date: s.date, name: st.workouts[s.workoutId]?.name ?? "Workout", workoutId: s.workoutId, scheduleId: s.scheduleId }));
        return json(items);
      }
      case "unschedule_workout":
        st.schedule = st.schedule.filter((s) => s.scheduleId !== Number(args.schedule_id));
        save(st);
        return json({ ok: true, removedScheduleId: args.schedule_id });
      case "delete_workout":
        delete st.workouts[String(args.workout_id)];
        st.schedule = st.schedule.filter((s) => s.workoutId !== Number(args.workout_id));
        save(st);
        return json({ ok: true, deletedWorkoutId: args.workout_id });
      case "get_workout":
        return text(st.workouts[String(args.workout_id)]?.summary ?? "Workout (couldn't summarise all steps)");
      case "list_workouts":
        return json(Object.entries(st.workouts).map(([id, w]) => ({ workoutId: +id, name: w.name, sport: "running" })));
    }
    return fail(name, "Unknown tool");
  } catch (e) {
    return fail(name, String((e as Error).message));
  }
}
