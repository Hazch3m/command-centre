import initSqlJs from "sql.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountHeader, buildAccountDb, EMPTY_PLAN } from "./account";
import { gunzip, gzip, linkKeys, newSecret, packSnapshot, seal, unpackSnapshot, unseal, type PhoneOp } from "./sync";

// The app's sync code, run the way the sync service runs it.
vi.mock("@backend", async () => await import("../../cloud/src/appBackend"));
const { runCloudSync } = await import("../../cloud/src/cloudSync");
const { verifyAppleToken, sha256hex } = await import("../../cloud/src/apple");
const { garminExchangeTicket } = await import("../../cloud/src/appBackend");

afterEach(() => vi.unstubAllGlobals());

async function account() {
  const SQL = await initSqlJs();
  const bytes = buildAccountDb(new SQL.Database());
  const secret = newSecret();
  const keys = await linkKeys(secret);
  let snap = { box: await seal(keys.key, await gzip(packSnapshot(accountHeader("2026-11-06"), bytes))), version: 1, applied: 0 };
  const phoneOps: { id: number; body: Uint8Array }[] = [];
  const io = {
    account: true,
    sqlJs: async () => SQL,
    creds: { secret, garmin: null, google: null, ics: [] },
    saveCreds: async () => {},
    loadSnapshot: async () => snap,
    saveSnapshot: async (box: Uint8Array, applied: number, _c: number, ifVersion: number) => {
      if (ifVersion !== snap.version) return false;
      snap = { box, version: snap.version + 1, applied };
      return true;
    },
    cloudOpsAfter: () => [],
    addCloudOp: () => 1,
    phoneOpsAfter: (id: number) => phoneOps.filter((o) => o.id > id),
  };
  const addPhoneOp = async (op: PhoneOp) => phoneOps.push({ id: phoneOps.length + 1, body: await seal(keys.key, new TextEncoder().encode(JSON.stringify(op))) });
  const open = async () => {
    const { header, db } = unpackSnapshot(await gunzip(await unseal(keys.key, snap.box)));
    return { header, db: new SQL.Database(db) };
  };
  return { io, addPhoneOp, open };
}

describe("accounts", () => {
  it("starts with every table the app needs and an empty plan", async () => {
    const SQL = await initSqlJs();
    const d = new SQL.Database(buildAccountDb(new SQL.Database()));
    const tables = d.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.flat();
    for (const t of ["kv", "_migrations", "strava_activities", "health_daily", "calendar_events", "tasks", "checklist_items", "plan_overrides", "vo2_readings"]) expect(tables).toContain(t);
    expect(JSON.parse(accountHeader("2026-11-06").files["training-plan.json"]).weeks).toEqual([]);
    expect(EMPTY_PLAN.editedInApp).toBeTruthy();
  });

  it("applies the phone's changes in the cloud, no PC needed", async () => {
    const t = await account();
    await t.addPhoneOp({ at: "x", stmts: [{ sql: "INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)", params: [7, "Buy gels", "2026-11-06T10:00:00Z"] }] });
    await t.addPhoneOp({ at: "x", file: { name: "training-plan.json", contents: JSON.stringify({ ...EMPTY_PLAN, title: "Built on the phone" }) } });
    // Something the phone may not change is ignored.
    await t.addPhoneOp({ at: "x", stmts: [{ sql: "DELETE FROM strava_activities", params: [] }] });
    const r = await runCloudSync(t.io, ["watch"]);
    expect(r.applied).toBe(3);
    const { header, db } = await t.open();
    expect(header.applied).toBe(3);
    expect(header.cloud).toBe(true);
    expect(JSON.parse(header.files["training-plan.json"]).title).toBe("Built on the phone");
    expect(db.exec("SELECT title FROM tasks")[0].values[0][0]).toBe("Buy gels");
    // Nothing new: nothing saved again.
    const again = await runCloudSync(t.io, ["watch"]);
    expect(again.wrote).toBe(0);
  });

  it("marks Garmin connected once the account holds a Garmin sign-in", async () => {
    const t = await account();
    t.io.creds = { ...t.io.creds, garmin: { access: "A", refresh: "R", client_id: "X", expires_at: Math.floor(Date.now() / 1000) + 9999 } } as never;
    await runCloudSync(t.io, ["watch"]);
    expect((await t.open()).header.connected.garmin).toBe(true);
  });
});

describe("Sign in with Apple", () => {
  let kids = 0;
  async function appleToken(claims: Record<string, unknown>) {
    const kid = `k${++kids}`;
    const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const body = `${enc({ alg: "RS256", kid })}.${enc(claims)}`;
    const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(body))).toString("base64url");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ kid, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] })));
    return `${body}.${sig}`;
  }
  const good = async (nonce: string) => ({ iss: "https://appleid.apple.com", aud: "com.hazch3m.commandcentre", exp: Math.floor(Date.now() / 1000) + 600, sub: "001234.abc", nonce: await sha256hex(nonce) });

  it("accepts Apple's token for this app with the right nonce", async () => {
    const tok = await appleToken(await good("n0nce"));
    expect((await verifyAppleToken(tok, "n0nce")).sub).toBe("001234.abc");
  });
  it("refuses another app's token, a wrong nonce, or an expired one", async () => {
    await expect(verifyAppleToken(await appleToken({ ...(await good("n")), aud: "com.other.app" }), "n")).rejects.toThrow(/another app/);
    await expect(verifyAppleToken(await appleToken(await good("n")), "different")).rejects.toThrow(/wasn't made/);
    await expect(verifyAppleToken(await appleToken({ ...(await good("n")), exp: 1000 }), "n")).rejects.toThrow(/expired/);
  });
  it("refuses a token whose signature doesn't match", async () => {
    const tok = await appleToken(await good("n"));
    const [h, , s] = tok.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ ...(await good("n")), sub: "someone-else" })).toString("base64url")}.${s}`;
    await expect(verifyAppleToken(forged, "n")).rejects.toThrow(/signature/);
  });
});

describe("Garmin sign-in from the phone", () => {
  it("swaps Garmin's ticket for tokens", async () => {
    const f = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("service_ticket=ST-12345678-abc");
      return Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", f);
    const t = await garminExchangeTicket("ST-12345678-abc");
    expect(t).toMatchObject({ access: "acc", refresh: "ref" });
  });
  it("refuses something that isn't a ticket", async () => {
    await expect(garminExchangeTicket("https://evil.example")).rejects.toThrow(/ticket/);
  });
});
