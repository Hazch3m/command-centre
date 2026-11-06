/**
 * Sign in with Apple: checks the identity token the iPhone app gets from Apple
 * (signed by Apple, for this app, not expired, carrying our one-time nonce).
 */
export const APPLE_ISSUER = "https://appleid.apple.com";
export const APP_BUNDLE_ID = "com.hazch3m.commandcentre";

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}
let keys: { at: number; list: Jwk[] } | null = null;

async function appleKeys(force = false): Promise<Jwk[]> {
  if (!force && keys && Date.now() - keys.at < 6 * 3600_000) return keys.list;
  const r = await fetch("https://appleid.apple.com/auth/keys");
  if (!r.ok) throw new Error(`Apple's sign-in keys couldn't be fetched (${r.status})`);
  keys = { at: Date.now(), list: ((await r.json()) as { keys: Jwk[] }).keys };
  return keys.list;
}

const b64urlBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
export const sha256hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((x) => x.toString(16).padStart(2, "0")).join("");

export interface AppleIdentity {
  sub: string;
  email: string | null;
}

/** Throws unless the token is genuine; returns who signed in. */
export async function verifyAppleToken(token: string, rawNonce: string, audience = APP_BUNDLE_ID, now = Date.now()): Promise<AppleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a sign-in token");
  const head = json(parts[0]) as { kid?: string; alg?: string };
  if (head.alg !== "RS256" || !head.kid) throw new Error("unexpected sign-in token");
  let jwk = (await appleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await appleKeys(true)).find((k) => k.kid === head.kid);
  if (!jwk) throw new Error("sign-in token from an unknown Apple key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("sign-in token signature doesn't match");
  const c = json(parts[1]) as { iss?: string; aud?: string; exp?: number; sub?: string; nonce?: string; email?: string };
  if (c.iss !== APPLE_ISSUER) throw new Error("sign-in token isn't from Apple");
  if (c.aud !== audience) throw new Error("sign-in token is for another app");
  if (!c.exp || c.exp * 1000 < now - 60_000) throw new Error("sign-in token has expired; sign in again");
  if (!c.sub) throw new Error("sign-in token has no user");
  if (!rawNonce || c.nonce !== (await sha256hex(rawNonce))) throw new Error("sign-in token wasn't made for this sign-in");
  return { sub: c.sub, email: c.email ?? null };
}
