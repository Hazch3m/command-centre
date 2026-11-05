import { useEffect } from "react";
import { backend } from "@backend";
import { db, kvGet, kvSet } from "./db";
import { notifyChanged } from "./events";
import type { PhoneLink } from "./backend.types";
import {
  b64url,
  gzip,
  linkKeys,
  newPairCode,
  newSecret,
  packSnapshot,
  pairId,
  PHONE_FILES,
  phoneMayWrite, REFRESH_KEY,
  seal,
  sealForCode,
  unseal,
  type LinkKeys,
  type PhoneOp,
} from "./sync";

/**
 * The PC's half of the phone link: sends the phone an encrypted copy of the
 * dashboard every few minutes (and soon after anything changes), and applies
 * the changes made on the phone (tasks, habits, plan days, a few settings).
 */

export interface PhoneStatus {
  lastPush: string | null;
  size: number;
  lastPull: string | null;
  applied: number;
  error: string | null;
}
const STATUS_KEY = "phone.status";
export const getPhoneStatus = () => kvGet<PhoneStatus>(STATUS_KEY, { lastPush: null, size: 0, lastPull: null, applied: 0, error: null });
const setStatus = async (p: Partial<PhoneStatus>) => kvSet(STATUS_KEY, { ...(await getPhoneStatus()), ...p });

let cached: { link: PhoneLink; keys: LinkKeys } | null = null;
async function current() {
  const link = await backend.phoneLinkGet().catch(() => null);
  if (!link) return (cached = null);
  if (cached?.link.secret !== link.secret || cached.link.url !== link.url) cached = { link, keys: await linkKeys(link.secret) };
  return cached;
}

const base = (url: string) => url.trim().replace(/\/+$/, "");

async function call(link: PhoneLink, keys: LinkKeys | null, path: string, init: RequestInit = {}, ms = 60_000): Promise<Response> {
  let r: Response;
  // A request that hangs (the PC slept mid-upload, a dropped connection) gives up, so it can't hold up every later sync.
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), ms);
  try {
    r = await fetch(`${base(link.url)}/api${path}`, { ...init, signal: ctl.signal, headers: { ...(keys ? { "x-cc-token": keys.token } : {}), ...(init.headers ?? {}) } });
  } catch (e) {
    throw new Error(ctl.signal.aborted ? `offline: the sync service didn't answer within ${ms / 1000} s` : `offline: couldn't reach the sync service (${String((e as Error)?.message ?? e)})`);
  } finally {
    window.clearTimeout(timer);
  }
  if (!r.ok) {
    const msg = await r
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => null);
    throw new Error(msg ?? `The sync service answered ${r.status}`);
  }
  return r;
}

/** First connection to a new sync service: makes the link's secret and claims the service. */
export async function connectService(url: string): Promise<void> {
  const u = base(url);
  if (!/^(https:\/\/[a-z0-9.-]+\.workers\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(u)) throw new Error("Paste the address shown after deploying, like https://command-centre-sync.yourname.workers.dev");
  const secret = newSecret();
  const keys = await linkKeys(secret);
  const link = { url: u, secret };
  await call(link, null, "/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: keys.token }) });
  await backend.phoneLinkSet(link);
  cached = null;
  await pushSnapshot();
}

/** New secret: every paired phone has to be linked again. */
export async function unlinkPhones(): Promise<void> {
  const c = await current();
  if (!c) return;
  const secret = newSecret();
  const keys = await linkKeys(secret);
  await call(c.link, c.keys, "/rotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: keys.token }) });
  await backend.phoneLinkSet({ url: c.link.url, secret });
  cached = null;
  await setStatus({ applied: 0 });
  await pushSnapshot();
}

export async function disconnectService(): Promise<void> {
  await backend.phoneLinkSet(null);
  cached = null;
  await kvSet(STATUS_KEY, { lastPush: null, size: 0, lastPull: null, applied: 0, error: null });
}

/** A pairing code for a phone, valid 15 minutes. */
export async function makePairCode(): Promise<{ code: string; url: string; expires: number }> {
  const c = await current();
  if (!c) throw new Error("Connect the sync service first.");
  const code = newPairCode();
  const body = JSON.stringify({ h: await pairId(code), blob: await sealForCode(code, c.link.secret) });
  const r = await call(c.link, c.keys, "/pair", { method: "POST", headers: { "content-type": "application/json" }, body });
  const { expires } = (await r.json()) as { expires: number };
  return { code, url: base(c.link.url), expires };
}

let pushing: Promise<void> | null = null;

/** Sends the phone a fresh copy of everything. */
export function pushSnapshot(): Promise<void> {
  pushing ??= doPush().finally(() => (pushing = null));
  return pushing;
}

async function doPush() {
  const c = await current();
  if (!c) return;
  try {
    const st = await getPhoneStatus();
    const files: Record<string, string> = {};
    for (const name of PHONE_FILES) {
      const text = await backend.readDataFile(name).catch(() => null);
      if (text != null) files[name] = text;
    }
    const [strava, google, garmin, ics] = await Promise.all([
      backend.oauthStatus("strava").catch(() => null),
      backend.oauthStatus("google").catch(() => null),
      backend.garminStatus().catch(() => null),
      backend.icsList().catch(() => []),
    ]);
    const bytes = packSnapshot(
      { v: 1, made: new Date().toISOString(), files, connected: { strava: !!strava?.connected, google: !!google?.connected, garmin: !!garmin?.connected }, ics, applied: st.applied },
      await backend.phoneSnapshot(),
    );
    const box = await seal(c.keys.key, await gzip(bytes));
    await call(c.link, c.keys, `/snapshot?applied=${st.applied}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: box as BodyInit }, 180_000);
    await setStatus({ lastPush: new Date().toISOString(), size: box.length, error: null });
  } catch (e) {
    await setStatus({ error: String((e as Error)?.message ?? e) });
    throw e;
  }
}

/** Applies changes made on the phone. Returns how many were applied. */
export async function pullPhoneChanges(): Promise<number> {
  const c = await current();
  if (!c) return 0;
  const st = await getPhoneStatus();
  const r = await call(c.link, c.keys, `/ops?after=${st.applied}`);
  const rows = (await r.json()) as { id: number; body: string }[];
  await setStatus({ lastPull: new Date().toISOString() });
  if (!rows.length) return 0;
  let upto = st.applied;
  let refreshAsked = false;
  let planChanged = false;
  for (const row of rows) {
    try {
      const op = JSON.parse(new TextDecoder().decode(await unseal(c.keys.key, b64url.decode(row.body.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))))) as PhoneOp;
      const stmts = (op.stmts ?? []).filter((s) => phoneMayWrite(s.sql, s.params));
      if (stmts.some((s) => s.params[0] === REFRESH_KEY)) refreshAsked = true;
      // Target settings changed on the phone: the plan views redraw with them.
      if (stmts.some((s) => s.params[0] === "running.prefs")) planChanged = true;
      if (stmts.length) await db.batch(stmts);
      if (op.file && PHONE_FILES.has(op.file.name) && typeof op.file.contents === "string") {
        JSON.parse(op.file.contents); // only well-formed files
        await backend.writeDataFile(op.file.name, op.file.contents);
        planChanged = true;
      }
    } catch (e) {
      // A change that can't be applied (e.g. its row was deleted here meanwhile) is skipped, not retried forever.
      console.warn("phone change skipped", row.id, e);
    }
    upto = row.id;
  }
  await setStatus({ applied: upto });
  await call(c.link, c.keys, "/ops/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ upto }) });
  for (const t of ["tasks", "checklist", "running", "calendar"]) await notifyChanged(t);
  if (planChanged) window.dispatchEvent(new Event("cc:plan-changed"));
  // The phone asked for fresh data: sync everything first (Background jobs does it, then sends a copy).
  if (refreshAsked) window.dispatchEvent(new Event("cc:refresh-request"));
  else await pushSnapshot().catch(() => {});
  return rows.length;
}

/**
 * Keeps the phone in step while the dashboard runs: phone changes every 30 s,
 * a new copy a minute after anything changes here, and every 10 minutes anyway.
 */
export function usePhoneSync() {
  useEffect(() => {
    let alive = true;
    let pushTimer: number | undefined;
    const schedulePush = (delay: number) => {
      window.clearTimeout(pushTimer);
      pushTimer = window.setTimeout(() => alive && pushSnapshot().catch(() => {}), delay);
    };
    const pull = () => pullPhoneChanges().catch(() => {});
    pull();
    schedulePush(15_000);
    const iv = window.setInterval(pull, 15_000);
    const iv2 = window.setInterval(() => schedulePush(0), 10 * 60_000);
    let off: (() => void) | undefined;
    backend.listen("data-changed", () => schedulePush(60_000)).then((u) => (alive ? (off = u) : u()));
    const onPlan = () => schedulePush(5_000);
    window.addEventListener("cc:plan-changed", onPlan);
    // Back from sleep or from the background: catch up with the phone straight away.
    let lastWake = Date.now();
    const wake = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastWake < 60_000) return;
      lastWake = Date.now();
      pull();
      schedulePush(3_000);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    return () => {
      alive = false;
      window.clearInterval(iv);
      window.clearInterval(iv2);
      window.clearTimeout(pushTimer);
      off?.();
      window.removeEventListener("cc:plan-changed", onPlan);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
    };
  }, []);
}
