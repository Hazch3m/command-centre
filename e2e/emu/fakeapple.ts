// The emulator's stand-in: "test:<who>" is a valid Apple token for <who>.
export const sha256hex = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function verifyAppleToken(token: string) { if (!token.startsWith("test:")) throw new Error("not a test token"); return { sub: token.slice(5), email: null }; }
