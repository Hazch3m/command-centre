import initSqlJs from "sql.js";
import { describe, expect, it, vi } from "vitest";

// The connector runs the app's code the way the sync service does.
vi.mock("@backend", async () => await import("../../cloud/src/appBackend"));

const { mcpResponse } = await import("../../cloud/src/connector");
const { migrations: runMigrations } = await import("../modules/running/strava");
const { migrations: healthMigrations } = await import("../modules/health/data");
const { BUNDLED_PLAN } = await import("../modules/running/plan");

const day = (n: number) => new Date(Date.UTC(2026, 10, 13) - n * 864e5).toISOString().slice(0, 10);

async function copy() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  for (const m of [...runMigrations, ...healthMigrations]) db.exec(m);
  const add = (id: string, date: string, km: number, secPerKm: number, hr: number) => {
    db.run(
      "INSERT INTO strava_activities (id, date, start_local, start_epoch, name, sport, distance, moving_time, elapsed_time, elevation, avg_hr, max_hr, synced_at) VALUES (?, ?, ?, ?, ?, 'Run', ?, ?, ?, 20, ?, ?, 'x')",
      [id, date, date + "T07:00:00", Date.parse(date + "T07:00:00Z") / 1000, "Run " + id, km * 1000, km * secPerKm, km * secPerKm, hr, hr + 15],
    );
    const splits = Array.from({ length: Math.floor(km) }, () => ({ distance: 1000, moving_time: secPerKm, speed: 1000 / secPerKm, gap: 1000 / secPerKm, hr, elev: 1 }));
    db.run("INSERT INTO strava_details (id, json, fetched_at) VALUES (?, ?, 'x')", [id, JSON.stringify({ splits, bestEfforts: km >= 5 ? [{ name: "5K", time: secPerKm * 5 }] : [] })]);
  };
  for (let i = 0; i < 40; i++) add("g" + (1000 + i), day(i * 2 + 1), 8 + (i % 4), 300 - (40 - i) * 0.5, 145);
  // The same morning from Strava's API (left out) and from Apple Health (Garmin's copy wins).
  add("99999", day(1), 8, 300, 145);
  add("hk" + "a".repeat(32), day(1), 8, 300, 145);
  return { db, files: { "training-plan.json": JSON.stringify(BUNDLED_PLAN) }, creds: { secret: "s", garmin: null, google: null, ics: [] } };
}

const call = async (body: unknown) => {
  const r = await mcpResponse(new Request("https://pacelife.run/api/mcp/main/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), copy, "2026-11-13");
  return { status: r.status, json: r.status === 202 ? null : ((await r.json()) as { result?: { content?: { text: string }[]; tools?: { name: string }[]; isError?: boolean }; error?: unknown }) };
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const { json } = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  expect(json?.result?.isError).toBe(false);
  return JSON.parse(json!.result!.content![0].text);
};

describe("Pacelife for Claude (MCP)", () => {
  it("introduces itself, lists read-only tools and ignores notifications", async () => {
    const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    expect(init.json?.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "Pacelife" } });
    expect((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json?.result?.tools?.map((t) => t.name)).toEqual(["get_overview", "get_plan", "get_runs", "get_run", "get_progress", "get_projections"]);
  });

  it("gives runs without Strava's API ones, and one copy of each run", async () => {
    const r = await tool("get_runs", { from: day(5), to: day(0) });
    // Newest first; the Strava-API and Apple Health copies of g1000's morning are left out.
    expect(r.runs.map((x: { id: string }) => x.id)).toEqual(["g1000", "g1001", "g1002"]);
    expect(r.runs[0]).toMatchObject({ km: 8, source: "Garmin" });
  });

  it("answers the overview, progress, plan, a run and projections", async () => {
    const o = await tool("get_overview");
    expect(o.today).toBe("2026-11-13");
    expect(o.volume.total_runs_on_record).toBe(40);
    const p = await tool("get_progress", { weeks: 12 });
    expect(p.weeks).toHaveLength(12);
    expect(p.best_times.find((b: { distance: string }) => b.distance === "5K").all_time.time).toBeTruthy();
    const plan = await tool("get_plan", { from: day(7), to: day(0) });
    expect(Array.isArray(plan.weeks)).toBe(true);
    const run = await tool("get_run", { id: "g1000" });
    expect(run.splits.length).toBe(8);
    const none = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_run", arguments: { id: "99999" } } });
    expect(none.json?.result?.isError).toBe(true);
    const proj = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_projections", arguments: {} } });
    expect(proj.json?.result?.content?.[0].text).toBeTruthy();
  });

  it("refuses unknown methods and tools", async () => {
    expect((await call({ jsonrpc: "2.0", id: 5, method: "resources/list" })).json?.error).toBeTruthy();
    expect((await call({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "delete_everything" } })).json?.error).toBeTruthy();
  });
});
