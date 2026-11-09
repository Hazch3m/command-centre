import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUNDLED_PLAN, type Plan } from "../running/plan";

// In-memory settings, a plan we can change, and a fake Garmin calendar.
const kv = new Map<string, unknown>();
vi.mock("../../core/db", () => ({
  kvGet: async (k: string, d: unknown) => (kv.has(k) ? structuredClone(kv.get(k)) : d),
  kvSet: async (k: string, v: unknown) => void kv.set(k, structuredClone(v)),
}));
let plan: Plan = BUNDLED_PLAN;
vi.mock("../running/plan", async (orig) => ({ ...(await orig<typeof import("../running/plan")>()), loadPlan: async () => ({ plan, error: null }) }));
const garmin = { n: 100, workouts: new Map<number, { name: string }>(), cal: new Map<number, { date: string; workoutId: number; name: string }>(), calls: [] as string[] };
vi.mock("./coach", () => ({
  getScheduled: async (from: string, to: string) => ({ ok: true, data: [...garmin.cal].filter(([, c]) => c.date >= from && c.date <= to).map(([scheduleId, c]) => ({ ...c, scheduleId })), text: "" }),
  create: async (w: { name: string }, date: string) => {
    const workoutId = ++garmin.n;
    garmin.workouts.set(workoutId, { name: w.name });
    const scheduleId = ++garmin.n;
    garmin.cal.set(scheduleId, { date, workoutId, name: w.name });
    garmin.calls.push(`create ${date}`);
    return { ok: true, data: { workoutId, scheduleId }, text: "" };
  },
  update: async (id: number, w: { name: string }) => {
    if (!garmin.workouts.has(id)) return { ok: false, kind: "error", message: "404" };
    garmin.workouts.set(id, { name: w.name });
    garmin.calls.push(`update ${id}`);
    return { ok: true, data: { workoutId: id }, text: "" };
  },
  unschedule: async (sid: number) => (garmin.cal.delete(sid), { ok: true, data: null, text: "" }),
  removeWorkout: async (id: number) => (garmin.workouts.delete(id), garmin.calls.push(`remove ${id}`), { ok: true, data: null, text: "" }),
}));

const { runAutoSync, setAutoSync, stopAutoSync, getAutoSyncState } = await import("./autoSync");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-02T09:00:00"));
  kv.clear();
  garmin.workouts.clear();
  garmin.cal.clear();
  garmin.calls = [];
  plan = BUNDLED_PLAN;
});
afterEach(() => vi.useRealTimers());

describe("watch sync", () => {
  it("does nothing until switched on", async () => {
    await runAutoSync();
    expect(garmin.calls).toEqual([]);
  });

  it("puts the next days' sessions on the Garmin calendar, once", async () => {
    await setAutoSync({ on: true, days: 7 });
    const st = await runAutoSync();
    const n = Object.keys(st.days).length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(garmin.cal.size).toBe(n);
    garmin.calls = [];
    await runAutoSync();
    expect(garmin.calls).toEqual([]); // nothing changed, nothing sent
  });

  it("follows plan changes: updates a changed day and removes one made a rest day", async () => {
    await setAutoSync({ on: true, days: 7 });
    const st = await runAutoSync();
    const [first, second] = Object.keys(st.days).sort();
    const keyOf = (d: string) => (["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const)[new Date(d + "T12:00").getDay()];
    const wi = plan.weeks.findIndex((w) => w.start <= first && first <= w.end);
    const wj = plan.weeks.findIndex((w) => w.start <= second && second <= w.end);
    const weeks = structuredClone(plan.weeks);
    weeks[wi].sessions = { ...weeks[wi].sessions, [keyOf(first)]: "8 km easy" };
    weeks[wj].sessions = { ...weeks[wj].sessions, [keyOf(second)]: "Rest" };
    plan = { ...plan, weeks };
    garmin.calls = [];
    const after = await runAutoSync();
    expect(garmin.calls.some((c) => c.startsWith("update"))).toBe(true);
    expect(garmin.calls.some((c) => c.startsWith("remove"))).toBe(true);
    expect(after.days[second]).toBeUndefined();
    expect([...garmin.cal.values()].some((c) => c.date === second)).toBe(false);
  });

  it("takes its workouts off again when switched off", async () => {
    await setAutoSync({ on: true, days: 7 });
    await runAutoSync();
    await stopAutoSync(true);
    expect(garmin.cal.size).toBe(0);
    expect(Object.keys((await getAutoSyncState()).days)).toHaveLength(0);
  });
});

describe("easy-run alerts", () => {
  it("drops heart-rate targets on easy steps (no beeping), or keeps only an upper limit, and leaves paces alone", async () => {
    const { easyTargets } = await import("./autoSync");
    const { sessionToWorkout } = await import("./importWeek");
    const w = sessionToWorkout("12 km with 3 km warm-up, Threshold: 4 × 2 km at 3:58–4:02, 90 s jog, 2 km cool-down")!;
    const all = (x: typeof w) => JSON.stringify(x);
    const off = easyTargets(w, "off", 150);
    expect(all(off)).not.toMatch(/hr zone/);
    expect(all(off)).toMatch(/pace 3:58/);
    expect(all(easyTargets(w, "ceiling", 150))).toMatch(/hr 60-150/);
    expect(all(easyTargets(w, "zone", 150))).toMatch(/hr zone 2/);
    const rec = sessionToWorkout("5 km recovery")!;
    expect(all(rec)).not.toMatch(/hr zone 1/);
  });
});
