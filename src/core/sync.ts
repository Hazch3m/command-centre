/**
 * The phone link's wire format, shared by the PC and the phone.
 *
 * Everything that reaches the sync service is encrypted here first (AES-GCM,
 * 256-bit), with a key derived from a secret that only the PC and your paired
 * phones know. The service stores ciphertext and the hash of an access token;
 * it can't read your data.
 *
 * - secret: 32 random bytes, base64url. Made on the PC, kept in its keychain.
 * - token:  SHA-256("cc-auth:" + secret), hex. Sent as the x-cc-token header.
 * - key:    SHA-256("cc-enc:" + secret), the AES-GCM key.
 * - pairing code: 8 letters/digits shown on the PC for 15 minutes. The phone
 *   swaps it for the secret, which the PC left on the service encrypted with a
 *   key stretched from the code (PBKDF2, 200k rounds).
 */

const te = new TextEncoder();
const td = new TextDecoder();

export const b64url = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(text: string): Uint8Array {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function newSecret(): string {
  return b64url.encode(crypto.getRandomValues(new Uint8Array(32)));
}

export interface LinkKeys {
  token: string;
  key: CryptoKey;
}

export async function linkKeys(secret: string): Promise<LinkKeys> {
  const raw = b64url.decode(secret);
  const token = hex(await sha256(concat(te.encode("cc-auth:"), raw)));
  const k = await sha256(concat(te.encode("cc-enc:"), raw));
  const key = await crypto.subtle.importKey("raw", k as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
  return { token, key };
}

export async function seal(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data as BufferSource));
  return concat(iv, ct);
}

export async function unseal(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12) as BufferSource));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
export const gzip = (b: Uint8Array) => pipe(b, new CompressionStream("gzip"));
export const gunzip = (b: Uint8Array) => pipe(b, new DecompressionStream("gzip"));

// ---- Snapshot: a header (JSON) and the SQLite file ------------------------------

export interface SnapshotHeader {
  v: 1;
  made: string;
  /** Hand-edited JSON files from the data folder (training plan, fitness settings). */
  files: Record<string, string>;
  /** Which services the PC is connected to, so the phone shows their data rather than "Connect". */
  connected: { strava: boolean; google: boolean; garmin: boolean };
  /** Calendar feeds by name (never their secret addresses). */
  ics: { id: string; name: string; host: string }[];
  /** The last phone change (op id) already in this snapshot. */
  applied: number;
  /** The last cloud change (cloud sync) already in this snapshot. */
  cloudApplied?: number;
  /** When the cloud last added to this copy. */
  cloudMade?: string;
  /** Cloud sync is on: the phone can ask the service to sync, and get Garmin data through it. */
  cloud?: boolean;
}

/** Changes the cloud made (new runs, health, calendar), for the PC and the phone to replay. */
export interface CloudOp {
  at: string;
  stmts: { sql: string; params: (string | number | null)[] }[];
}

/** Tables the cloud may write (and the PC and phone accept from it). */
export const CLOUD_TABLES = new Set(["strava_activities", "run_extra", "strava_details", "strava_full", "health_daily", "calendar_events", "vo2_readings", "kv"]);
/** kv keys the cloud may write: the sync states and lists its sync code keeps. */
export const CLOUD_KV = /^(health\.|calendar\.(sync|calendars)$|garmin\.runs\.sync$|watch\.autosync$|strava\.(sync|shoes|retired)$)/;

/** May a statement from the cloud be applied (on the PC, the phone, or the cloud's own copy)? */
export function cloudMayWrite(sql: string, params: unknown[]): boolean {
  const s = sql.trim();
  if (s.replace(/;\s*$/, "").includes(";") || /\b(ATTACH|DETACH|PRAGMA|DROP|ALTER|CREATE|VACUUM)\b/i.test(s)) return false;
  const t = /^(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)/i.exec(s)?.[1]?.toLowerCase();
  if (!t || !CLOUD_TABLES.has(t)) return false;
  return t !== "kv" || (typeof params[0] === "string" && CLOUD_KV.test(params[0]));
}



export function packSnapshot(h: SnapshotHeader, db: Uint8Array): Uint8Array {
  const head = te.encode(JSON.stringify(h));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, head.length, true);
  return concat(len, head, db);
}

export function unpackSnapshot(b: Uint8Array): { header: SnapshotHeader; db: Uint8Array } {
  const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  return { header: JSON.parse(td.decode(b.slice(4, 4 + n))), db: b.slice(4 + n) };
}

// ---- Changes made on the phone ---------------------------------------------------

export interface PhoneOp {
  at: string;
  /** SQL to replay on the PC, each limited to the tables below. */
  stmts?: { sql: string; params: (string | number | null)[] }[];
  /** A data file written on the phone (the training plan, edited there). */
  file?: { name: string; contents: string };
}

/** Tables the phone may change. Everything else (synced data, caches) comes only from the PC. */
export const PHONE_TABLES = new Set(["tasks", "projects", "checklist_items", "checklist_log", "plan_overrides", "vo2_readings", "kv", "strava_activities", "strava_details", "strava_full", "health_daily"]);
/** Runs the phone itself reads (Apple Health, ids starting "hk"): only those, never Garmin or Strava rows. */
const PHONE_RUN_TABLES = new Set(["strava_activities", "strava_details", "strava_full"]);
/** kv keys the phone may change: view choices and settings, never sync state. */
const KV_ALLOWED = [/^calendar\.view\./, /^shape\.settings$/, /^checklist\./, /^tasks\.(view|filter|sort)/, /^phone\.refresh$/, /^running\.prefs$/, /^watch\.autosync\.settings$/, /^run\.meta\./, /^gear\.shoes$/, /^hr\.zones$/, /^running\.paceGoals$/, /^phone\.today$/, /^running\.focusSource$/, /^plan\.highlight$/, /^apple\.health$/, /^goals\.snap$/];
/** The phone's "refresh" button: asks the PC to sync Strava, Garmin and the calendar now and send a fresh copy. */
export const REFRESH_KEY = "phone.refresh";
/** Set by the PC (never the phone) to the request it has just answered. */
export const REFRESHED_KEY = "phone.refreshed";
export const PHONE_FILES = new Set(["training-plan.json", "fitness.json"]);

/** The table a single write statement changes, or null if it isn't a plain single write. */
export function writeTarget(sql: string): string | null {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) return null;
  const m = /^(?:INSERT(?:\s+OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK))?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`]?(\w+)["`]?/i.exec(s);
  return m ? m[1].toLowerCase() : null;
}

/** Is this statement one the phone may send (and the PC may replay)? */
export function phoneMayWrite(sql: string, params: unknown[]): boolean {
  const t = writeTarget(sql);
  if (!t || !PHONE_TABLES.has(t)) return false;
  if (/\b(ATTACH|DETACH|PRAGMA|DROP|ALTER|CREATE|VACUUM)\b/i.test(sql)) return false;
  if (t === "kv") {
    const key = typeof params[0] === "string" ? params[0] : null;
    return !!key && KV_ALLOWED.some((r) => r.test(key));
  }
  if (PHONE_RUN_TABLES.has(t)) {
    // Inserting or updating one Apple Health run, or one from your Strava archive (its id among the values); no deletes.
    if (/^\s*DELETE/i.test(sql)) return false;
    return params.some((p) => typeof p === "string" && /^(hk[0-9a-f]{32}|sx\d{1,20})$/.test(p));
  }
  // Apple Health's days only fill gaps: never overwrite what Garmin recorded.
  if (t === "health_daily") return /^\s*INSERT/i.test(sql) && /DO UPDATE SET rhr = COALESCE\(health_daily\.rhr, excluded\.rhr\)/i.test(sql) && !/=\s*excluded\.(?!\w+\))/i.test(sql.replace(/COALESCE\(health_daily\.\w+, excluded\.\w+\)/gi, ""));
  return true;
}

// ---- Pairing codes -----------------------------------------------------------------

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
export function newPairCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return [...r].map((x) => ALPHABET[x % ALPHABET.length]).join("");
}
export const cleanCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;

export async function pairId(code: string): Promise<string> {
  return hex(await sha256(te.encode("cc-pair:" + cleanCode(code))));
}

async function codeKey(code: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", te.encode(cleanCode(code)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: te.encode("cc-pair-salt"), iterations: 200_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealForCode(code: string, secret: string): Promise<string> {
  return b64url.encode(await seal(await codeKey(code), te.encode(secret)));
}

export async function openWithCode(code: string, blob: string): Promise<string> {
  return td.decode(await unseal(await codeKey(code), b64url.decode(blob)));
}

/**
 * New rows made on the phone get ids from their own range (time-based, far
 * above the PC's), so a task added on the phone and one added on the PC at the
 * same time can't end up with the same id when the change is replayed.
 */
const ID_TABLES = /^\s*INSERT\s+INTO\s+(tasks|projects|checklist_items)\s*\(([^)]*)\)\s*VALUES\s*\(/i;
export function withPhoneId(sql: string, params: (string | number | null)[]): { sql: string; params: (string | number | null)[] } {
  const m = ID_TABLES.exec(sql);
  if (!m || /\bid\b/i.test(m[2])) return { sql, params };
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const out = sql.replace(ID_TABLES, (_all, t: string, cols: string) => `INSERT INTO ${t} (id, ${cols.trim()}) VALUES (?, `);
  return { sql: out, params: [id, ...params] };
}
