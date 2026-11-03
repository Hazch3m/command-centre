import { backend } from "@backend";
import type { McpCallResult, McpTool, WatchStatus } from "../../core/backend.types";
import { kvGet, kvSet } from "../../core/db";
import { toToolSteps, type Item, type Workout } from "./steps";

/**
 * Talking to garmin-coach. The app starts the user's own garmin-coach MCP
 * server and calls its tools; argument names come from each tool's schema as
 * the server reports it, so nothing about the tools is hard-coded beyond their
 * names and meaning.
 */

export interface WatchSettings {
  /** Folder with server.py; empty = look in the usual places. */
  folder: string;
  /** Python to run it with; empty = the folder's .venv. */
  python: string;
}
export const getWatchSettings = () => kvGet<WatchSettings>("watch.settings", { folder: "", python: "" });
export async function saveWatchSettings(s: WatchSettings) {
  await kvSet("watch.settings", s);
  tools = null;
  await backend.watchDisconnect().catch(() => {});
  setLink({ state: "unknown", message: null });
}

// ---- connection state (the status light) ----

export type LinkState = "unknown" | "connecting" | "ok" | "login" | "down";
export interface Link {
  state: LinkState;
  message: string | null;
}
let link: Link = { state: "unknown", message: null };
const listeners = new Set<() => void>();
function setLink(l: Link) {
  link = l;
  listeners.forEach((f) => f());
}
export const getLink = () => link;
export const subscribeLink = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export const LOGIN_MESSAGE = "Garmin login expired, run python login.py in garmin-coach-mcp";
const LOGIN_RE = /login\.py|no saved garmin login|no garmin login|\b401\b|\b403\b|unauthori[sz]ed|authenticat|oauth|token|login/i;

// ---- tools ----

let tools: Map<string, McpTool> | null = null;
let connecting: Promise<Map<string, McpTool>> | null = null;

export async function status(): Promise<WatchStatus> {
  const s = await getWatchSettings();
  return backend.watchStatus(s.folder, s.python);
}

async function connect(): Promise<Map<string, McpTool>> {
  if (tools) return tools;
  connecting ??= (async () => {
    setLink({ state: "connecting", message: null });
    try {
      const s = await getWatchSettings();
      const list = await backend.watchConnect(s.folder, s.python);
      tools = new Map(list.map((t) => [t.name, t]));
      return tools;
    } catch (e) {
      setLink({ state: "down", message: String((e as Error)?.message ?? e) });
      throw e;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export async function listTools(): Promise<McpTool[]> {
  return [...(await connect()).values()];
}

export type Outcome<T = unknown> =
  | { ok: true; data: T; text: string }
  | { ok: false; kind: "login" | "invalid" | "error"; message: string };

/** Fits arguments to the tool's input schema: unknown keys dropped, required ones checked. */
export function fitArgs(tool: McpTool, args: Record<string, unknown>): Record<string, unknown> {
  const props = tool.inputSchema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (k in props && v !== undefined && v !== null && v !== "") out[k] = v;
  const missing = (tool.inputSchema.required ?? []).filter((k) => out[k] === undefined);
  if (missing.length) throw new Error(`${tool.name} needs ${missing.join(", ")}`);
  return out;
}

/** What a tool returned: structured content if there is any, else the text parsed as JSON where possible. */
export function readResult(r: McpCallResult): { data: unknown; text: string } {
  const texts = (r.content ?? []).filter((c) => c.type === "text" && c.text != null).map((c) => c.text!);
  const text = texts.join("\n");
  const sc = r.structuredContent as Record<string, unknown> | undefined;
  if (sc && typeof sc === "object") return { data: "result" in sc && Object.keys(sc).length === 1 ? sc.result : sc, text };
  const parsed = texts.map((t) => {
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  });
  return { data: parsed.length === 1 ? parsed[0] : parsed, text };
}

/** Calls a garmin-coach tool by name; arguments are checked against its schema first. */
export async function call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<Outcome<T>> {
  let t: Map<string, McpTool>;
  try {
    t = await connect();
  } catch (e) {
    return { ok: false, kind: "error", message: String((e as Error)?.message ?? e) };
  }
  const tool = t.get(name);
  if (!tool) return { ok: false, kind: "error", message: `garmin-coach has no ${name} tool (it has: ${[...t.keys()].join(", ")})` };
  let res: McpCallResult;
  try {
    const a = fitArgs(tool, args);
    try {
      res = await backend.watchCall(name, a);
    } catch (e) {
      // The server may have stopped (sleep, crash): start it again once.
      if (!/isn't running|closed|transport|broken pipe/i.test(String(e))) throw e;
      tools = null;
      await connect();
      res = await backend.watchCall(name, a);
    }
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    const login = LOGIN_RE.test(message);
    setLink(login ? { state: "login", message: LOGIN_MESSAGE } : { state: "down", message });
    return { ok: false, kind: login ? "login" : "error", message: login ? LOGIN_MESSAGE : message };
  }
  const { data, text } = readResult(res);
  if (res.isError) {
    const login = LOGIN_RE.test(text);
    if (login) setLink({ state: "login", message: LOGIN_MESSAGE });
    else setLink({ state: "ok", message: null });
    return { ok: false, kind: login ? "login" : /invalid workout/i.test(text) ? "invalid" : "error", message: login ? LOGIN_MESSAGE : text };
  }
  // Workout problems come back as a normal answer: "Invalid workout: …" or { ok: false, error }.
  if (typeof data === "string" && /^invalid workout/i.test(data)) return { ok: false, kind: "invalid", message: data };
  if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) {
    const err = String((data as { error?: string }).error ?? text);
    return { ok: false, kind: "invalid", message: `Invalid workout: ${err}` };
  }
  setLink({ state: "ok", message: null });
  return { ok: true, data: data as T, text };
}

// ---- the tools, with the rules applied ----

export interface Scheduled {
  date: string;
  name: string;
  workoutId: number;
  scheduleId: number;
}

export async function getScheduled(from: string, to: string): Promise<Outcome<Scheduled[]>> {
  const r = await call<unknown>("get_scheduled", { start_date: from, end_date: to });
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  return { ok: true, text: r.text, data: list.filter((x): x is Scheduled => !!x && typeof x === "object" && "date" in x) };
}

const workoutArgs = (w: Workout) => ({ name: w.name.trim(), steps: toToolSteps(w.steps), sport: w.sport || "running", description: w.description.trim() || undefined });

export const preview = (w: Workout) => call<string>("preview_workout", workoutArgs(w));
export const create = (w: Workout, date?: string) => call<{ workoutId: number; scheduleId?: number }>("create_workout", { ...workoutArgs(w), date });
export const update = (workoutId: number, w: Workout) => call<{ workoutId: number }>("update_workout", { workout_id: workoutId, ...workoutArgs(w) });
export const unschedule = (scheduleId: number) => call("unschedule_workout", { schedule_id: scheduleId });
export const removeWorkout = (workoutId: number) => call("delete_workout", { workout_id: workoutId });
export const getWorkout = (workoutId: number) => call<string>("get_workout", { workout_id: workoutId });

/**
 * When preview says "Invalid workout", find which step: preview each step on
 * its own (and each step inside a repeat) until one fails. Returns the step's
 * id and garmin-coach's message for it.
 */
export async function findBadStep(w: Workout): Promise<{ id: string; message: string } | null> {
  const one = async (items: Item[]) => {
    const r = await preview({ ...w, steps: items });
    return r.ok ? null : r.message;
  };
  for (const it of w.steps) {
    if (it.kind === "repeat") {
      if (!Number.isInteger(it.times) || it.times < 1) return { id: it.id, message: "A repeat needs a whole number of times (1 or more)." };
      if (!it.steps.length) return { id: it.id, message: "This repeat has no steps." };
      for (const s of it.steps) {
        const m = await one([s]);
        if (m) return { id: s.id, message: m.replace(/^Invalid workout:\s*Step 1:?\s*/i, "") };
      }
      continue;
    }
    const m = await one([it]);
    if (m) return { id: it.id, message: m.replace(/^Invalid workout:\s*Step 1:?\s*/i, "") };
  }
  return null;
}

// ---- what this app put on Garmin (so a workout can be edited later) ----

export const getSaved = () => kvGet<Record<string, Workout>>("watch.saved", {});
export async function remember(workoutId: number, w: Workout) {
  const all = await getSaved();
  all[String(workoutId)] = w;
  await kvSet("watch.saved", all);
}
