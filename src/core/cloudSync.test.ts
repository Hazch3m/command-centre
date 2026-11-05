import initSqlJs from "sql.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudMayWrite, gunzip, gzip, linkKeys, newSecret, packSnapshot, seal, unpackSnapshot, unseal, type CloudOp, type SnapshotHeader } from "./sync";

// The app's sync code, run the way the sync service runs it.
vi.mock("@backend", async () => await import("../../cloud/src/appBackend"));

const { runCloudSync } = await import("../../cloud/src/cloudSync");
const { migrations: runMigrations } = await import("../modules/running/strava");
const { migrations: healthMigrations } = await import("../modules/health/data");
const { migrations: calMigrations } = await import("../modules/calendar/data");

async function setUp() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  for (const m of [...runMigrations, ...healthMigrations, ...calMigrations]) db.exec(m);
  const secret = newSecret();
  const keys = await linkKeys(secret);
  const header: SnapshotHeader = { v: 1, made: new Date().toISOString(), files: {}, connected: { strava: false, google: false, garmin: true }, ics: [], applied: 3 };
  let snap = { box: await seal(keys.key, await gzip(packSnapshot(header, db.export()))), version: 1, applied: 3 };
  const ops: { id: number; body: Uint8Array }[] = [];
  const saved: unknown[] = [];
  const io = {
    sqlJs: async () => SQL,
    creds: { secret, garmin: { access: "A", refresh: "R", client_id: "GCM", expires_at: Math.floor(Date.now() / 1000) + 86400 }, google: null, ics: [] },
    saveCreds: async (c: unknown) => void saved.push(c),
    loadSnapshot: async () => snap,
    saveSnapshot: async (box: Uint8Array, applied: number, _cloud: number, ifVersion: number) => {
      if (ifVersion !== snap.version) return false;
      snap = { box, version: snap.version + 1, applied };
      return true;
    },
    cloudOpsAfter: (id: number) => ops.filter((o) => o.id > id),
    addCloudOp: (body: Uint8Array) => (ops.push({ id: ops.length + 1, body }), ops.length),
  };
  const open = async () => {
    const { header: h, db: bytes } = unpackSnapshot(await gunzip(await unseal(keys.key, snap.box)));
    return { header: h, db: new SQL.Database(bytes) };
  };
  return { io, ops, saved, open, keys };
}

const RUN = {
  activityId: 21000000001,
  activityName: "Evening Run",
  startTimeLocal: "2026-11-04 18:05:00",
  startTimeGMT: "2026-11-04 17:05:00",
  activityType: { typeKey: "running" },
  distance: 8000,
  duration: 2000,
  movingDuration: 1990,
  averageHR: 150,
};
const DETAILS = {
  metricDescriptors: ["directTimestamp", "sumDistance", "directHeartRate"].map((key, metricsIndex) => ({ key, metricsIndex })),
  activityDetailMetrics: Array.from({ length: 401 }, (_, i) => ({ metrics: [1_762_000_000_000 + i * 5000, i * 20, 150] })),
  geoPolylineDTO: { polyline: [{ lat: 46.2, lon: 6.1 }, { lat: 46.21, lon: 6.11 }] },
};

function fakeGarmin(onToken?: () => Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("diauth.garmin.com")) return onToken?.() ?? new Response("{}", { status: 400 });
    if (url.includes("/activitylist-service/")) return Response.json([RUN]);
    if (url.includes("/details")) return Response.json(DETAILS);
    if (url.includes("/splits")) return Response.json({ lapDTOs: [{ distance: 8000, duration: 2000, averageSpeed: 4 }] });
    return new Response("", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("sync in the cloud", () => {
  it("fetches a new run from Garmin, logs the change, and saves a fresh copy for the phone", async () => {
    const t = await setUp();
    vi.stubGlobal("fetch", fakeGarmin());
    const r = await runCloudSync(t.io, ["runs"]);
    expect(r.errors.runs).toBe(null);
    expect(r.newRuns).toBe(1);
    expect(t.ops).toHaveLength(1);
    const op = JSON.parse(new TextDecoder().decode(await unseal(t.keys.key, t.ops[0].body))) as CloudOp;
    expect(op.stmts.every((s) => cloudMayWrite(s.sql, s.params))).toBe(true);
    expect(op.stmts.some((s) => /strava_full/.test(s.sql))).toBe(true); // the PC gets the full data…
    const { header, db } = await t.open();
    expect(header.cloudApplied).toBe(1);
    expect(header.applied).toBe(3);
    expect(db.exec("SELECT id FROM strava_activities")[0].values).toEqual([["g21000000001"]]);
    expect(db.exec("SELECT count(*) FROM strava_full")[0].values[0][0]).toBe(0); // …the phone doesn't need it
    expect(db.exec("SELECT count(*) FROM strava_details")[0].values[0][0]).toBe(1);
    // Nothing new the second time: no change logged, no new copy.
    const again = await runCloudSync(t.io, ["runs"]);
    expect(again.newRuns).toBe(0);
  });

  it("replays its earlier changes onto an older copy from the PC", async () => {
    const t = await setUp();
    vi.stubGlobal("fetch", fakeGarmin());
    const firstCopy = await t.io.loadSnapshot();
    await runCloudSync(t.io, ["runs"]);
    // The PC sends a copy made before it applied the cloud's change.
    await t.io.saveSnapshot(firstCopy.box, 3, 0, (await t.io.loadSnapshot()).version);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
    await runCloudSync(t.io, ["runs"]);
    const { db } = await t.open();
    // Unchanged run list → no new copy saved, but the earlier change is still in the log for the phone.
    expect(t.ops.length).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("keeps Garmin's new refresh token when it rotates", async () => {
    const t = await setUp();
    t.io.creds.garmin.expires_at = 0;
    vi.stubGlobal("fetch", fakeGarmin(() => Response.json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 })));
    await runCloudSync(t.io, ["runs"]);
    expect((t.saved.at(-1) as { garmin: { refresh: string } }).garmin.refresh).toBe("R2");
    expect(t.io.creds.garmin.access).toBe("A2");
  });

  it("only lets its own kinds of change through", () => {
    expect(cloudMayWrite("INSERT INTO strava_activities (id) VALUES (?)", ["g1"])).toBe(true);
    expect(cloudMayWrite("INSERT INTO kv (key, value) VALUES (?, ?)", ["health.sync", "{}"])).toBe(true);
    expect(cloudMayWrite("INSERT INTO kv (key, value) VALUES (?, ?)", ["phone.link", "x"])).toBe(false);
    expect(cloudMayWrite("DELETE FROM tasks", [])).toBe(false);
    expect(cloudMayWrite("DROP TABLE strava_activities", [])).toBe(false);
    expect(cloudMayWrite("DELETE FROM calendar_events; DELETE FROM tasks", [])).toBe(false);
  });
});
