/**
 * The app's backend, as the sync service runs it. Command Centre's own sync
 * code (Garmin runs and health, Google Calendar and calendar feeds) runs here
 * unchanged against a working copy of your database, so the phone gets new
 * data with the PC switched off.
 *
 * Every write is recorded, so the PC and the phone can replay exactly the
 * same changes. Garmin and Google are called with the sign-ins the PC handed
 * over (Settings → Phone → Sync in the cloud).
 */
import type { Database } from "sql.js";

export interface GarminToken {
  access: string;
  refresh: string | null;
  client_id: string;
  /** Unix seconds */
  expires_at: number;
}
export interface GoogleCreds {
  client: { id: string; secret: string };
  token: { access_token: string; refresh_token: string | null; expires_at: number; account?: string | null };
}
export interface Creds {
  /** The link's secret: lets the service open and re-seal your data. */
  secret: string;
  garmin: GarminToken | null;
  google: GoogleCreds | null;
  ics: { id: string; name: string; url: string }[];
}

type Param = string | number | null;
interface Ctx {
  db: Database;
  /** The plan and fitness files from the PC's copy. */
  files?: Record<string, string>;
  writes: { sql: string; params: Param[] }[];
  creds: Creds;
  /** Called when a token is refreshed (Garmin's rotate), so the new one is kept. */
  saveCreds: (c: Creds) => Promise<void>;
}
let ctx: Ctx | null = null;
export const setContext = (c: Ctx | null) => (ctx = c);
const need = () => {
  if (!ctx) throw new Error("no working copy open");
  return ctx;
};

const norm = (ps: unknown[] = []) => ps.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v)) as Param[];

function select<T>(sql: string, params: unknown[] = []): T[] {
  const st = need().db.prepare(sql);
  try {
    st.bind(norm(params));
    const out: T[] = [];
    while (st.step()) out.push(st.getAsObject() as T);
    return out;
  } finally {
    st.free();
  }
}
function execute(sql: string, params: unknown[] = []) {
  const c = need();
  const p = norm(params);
  if (!p.length && sql.trim().replace(/;$/, "").includes(";")) c.db.exec(sql);
  else c.db.run(sql, p);
  const changes = c.db.getRowsModified();
  if (changes > 0) c.writes.push({ sql, params: p });
  return { changes, lastInsertId: Number(c.db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] ?? 0) };
}

// ---- Garmin ------------------------------------------------------------------------

const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const GARMIN_API = "https://connectapi.garmin.com";
/** Read-only services the app may call (the same list as the PC). */
export const GARMIN_ALLOWED = [
  "/metrics-service/",
  "/hrv-service/",
  "/wellness-service/",
  "/sleep-service/",
  "/userstats-service/",
  "/usersummary-service/",
  "/userprofile-service/",
  "/activitylist-service/activities/search/activities",
  "/activity-service/activity/",
  "/calendar-service/year/",
  "/workout-service/workout/",
];
/** The headers Garmin's Android app sends; the token service and API expect them. */
const NATIVE: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent": "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};
const nowS = () => Math.floor(Date.now() / 1000);

async function garminRefresh(c: { creds: Creds; saveCreds: Ctx["saveCreds"] }): Promise<GarminToken> {
  const t = c.creds.garmin;
  if (!t?.refresh) throw new Error("Garmin sign-in expired. Connect Garmin again on the PC, then switch cloud sync off and on.");
  const r = await fetch(DI_TOKEN_URL, {
    method: "POST",
    headers: { ...NATIVE, Authorization: `Basic ${btoa(`${t.client_id}:`)}`, Accept: "application/json", "Cache-Control": "no-cache", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: t.client_id, refresh_token: t.refresh }),
  });
  if (!r.ok) throw new Error(r.status === 400 || r.status === 401 ? "Garmin sign-in expired. Connect Garmin again on the PC, then switch cloud sync off and on." : `Garmin token refresh failed (HTTP ${r.status})`);
  const v = (await r.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!v.access_token) throw new Error("Garmin didn't return an access token");
  // The refresh token rotates: keep the new one straight away.
  const nt: GarminToken = { access: v.access_token, refresh: v.refresh_token ?? t.refresh, client_id: t.client_id, expires_at: nowS() + (v.expires_in ?? 3600) };
  c.creds = { ...c.creds, garmin: nt };
  await c.saveCreds(c.creds);
  return nt;
}

/** Where writes may go: creating, changing, scheduling and removing workouts. */
export const GARMIN_WRITE_ALLOWED = ["/workout-service/workout", "/workout-service/schedule/"];

/** GET a Garmin Connect address with the handed-over sign-in. Also used directly by the /garmin pass-through. */
export async function garminGet(c: { creds: Creds; saveCreds: Ctx["saveCreds"] }, path: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", payload?: unknown): Promise<{ status: number; body: unknown }> {
  const allowed = method === "GET" ? GARMIN_ALLOWED : GARMIN_WRITE_ALLOWED;
  if (!path.startsWith("/") || path.includes("..") || path.includes("://") || (method !== "GET" && path.includes("?")) || !allowed.some((p) => path.startsWith(p)))
    throw new Error(`${path} is not an allowed Garmin address`);
  let t = c.creds.garmin;
  if (!t) throw new Error("Garmin isn't connected");
  if (t.expires_at <= nowS() + 600) t = await garminRefresh(c);
  for (let tries = 0; tries < 2; tries++) {
    const r = await fetch(GARMIN_API + path, {
      method,
      headers: { ...NATIVE, Authorization: `Bearer ${t.access}`, Accept: "application/json", NK: "NT", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    if (r.status === 401 && tries === 0) {
      t = await garminRefresh(c);
      continue;
    }
    const text = await r.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: r.status, body };
  }
  return { status: 401, body: null };
}

// ---- Google ------------------------------------------------------------------------

const GOOGLE_API = ["https://www.googleapis.com/calendar/v3/", "https://tasks.googleapis.com/tasks/v1/", "https://www.googleapis.com/tasks/v1/"];

async function googleToken(c: Ctx): Promise<string> {
  const g = c.creds.google;
  if (!g) throw new Error("Not connected. Connect it in Settings.");
  if (g.token.expires_at > nowS() + 60) return g.token.access_token;
  if (!g.token.refresh_token) throw new Error("Sign-in expired. Reconnect it in Settings.");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: g.client.id, client_secret: g.client.secret, grant_type: "refresh_token", refresh_token: g.token.refresh_token }),
  });
  const v = (await r.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!v.access_token) throw new Error(v.error === "invalid_grant" ? "Google sign-in expired or was revoked. Reconnect it on the PC." : "Google refused the sign-in");
  c.creds = { ...c.creds, google: { ...g, token: { ...g.token, access_token: v.access_token, expires_at: nowS() + (v.expires_in ?? 3600) } } };
  await c.saveCreds(c.creds);
  return v.access_token;
}

// ---- The backend the app's code sees ------------------------------------------------

const notHere = (what: string) => () => Promise.reject(new Error(`offline: ${what} isn't available in the cloud`));

export const backend = {
  kind: "cloud",
  select: async <T,>(sql: string, params?: unknown[]) => select<T>(sql, params),
  execute: async (sql: string, params?: unknown[]) => execute(sql, params),
  batch: async (statements: { sql: string; params?: unknown[] }[]) => {
    const c = need();
    c.db.exec("BEGIN");
    try {
      const out = statements.map((s) => execute(s.sql, s.params ?? []));
      c.db.exec("COMMIT");
      return out;
    } catch (e) {
      c.db.exec("ROLLBACK");
      throw e;
    }
  },
  emit: async () => {},
  listen: async () => () => {},
  garminStatus: async () => ({ connected: !!ctx?.creds.garmin }),
  garminRequest: async <T,>(path: string) => (await garminGet(need(), path)) as { status: number; body: T },
  garminWrite: async <T,>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) => (await garminGet(need(), path, method, body)) as { status: number; body: T },
  oauthStatus: async (p: string) => {
    const ok = p === "google" && !!ctx?.creds.google;
    return { configured: ok, connected: ok, account: ok ? ctx?.creds.google?.token.account ?? null : null };
  },
  apiRequest: async <T,>(p: string, method: string, url: string, body?: unknown) => {
    if (p !== "google" || !GOOGLE_API.some((x) => url.startsWith(x))) throw new Error(`${p} isn't available in the cloud`);
    const c = need();
    let token = await googleToken(c);
    for (let tries = 0; tries < 2; tries++) {
      const r = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
      if (r.status === 401 && tries === 0) {
        c.creds = { ...c.creds, google: c.creds.google && { ...c.creds.google, token: { ...c.creds.google.token, expires_at: 0 } } };
        token = await googleToken(c);
        continue;
      }
      const text = await r.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep text */
      }
      return { status: r.status, body: parsed as T };
    }
    return { status: 401, body: null as T };
  },
  icsList: async () => (ctx?.creds.ics ?? []).map((f) => ({ id: f.id, name: f.name, host: new URL(f.url).host })),
  icsFetch: async (id: string) => {
    const f = need().creds.ics.find((x) => x.id === id);
    if (!f) throw new Error("unknown calendar feed");
    const r = await fetch(f.url);
    if (!r.ok) throw new Error(`The calendar feed answered ${r.status}`);
    return r.text();
  },
  readDataFile: async (name: string) => ctx?.files?.[name] ?? null,
  writeDataFile: notHere("writing files"),
  weatherFetch: notHere("weather"),
};
