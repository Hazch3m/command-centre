/**
 * The iPhone app's own abilities (mobile/ios-plugin): Sign in with Apple, and
 * Garmin's sign-in page in a window of its own that hands back Garmin's ticket.
 * In a browser these aren't there; the phone app then offers a pairing code.
 */
interface CCNative {
  signInWithApple(o: { nonce: string }): Promise<{ identityToken: string; email?: string | null; name?: string | null }>;
  garminLogin(o: { url: string }): Promise<{ ticket: string }>;
}
type Cap = { isNativePlatform?: () => boolean; registerPlugin?: <T>(name: string) => T };

const cap = () => (globalThis as unknown as { Capacitor?: Cap }).Capacitor;

/** Inside the iPhone app (not a browser)? */
export const isNativeApp = () => !!cap()?.isNativePlatform?.() || /CommandCentreApp/.test(globalThis.navigator?.userAgent ?? "");

let plugin: CCNative | null = null;
export function native(): CCNative {
  const c = cap();
  if (!c?.registerPlugin) throw new Error("This needs the Command Centre iPhone app.");
  plugin ??= c.registerPlugin<CCNative>("CCNative");
  return plugin;
}

/** Garmin's sign-in page; ends with a redirect to connect.garmin.com/app?ticket=… */
export const GARMIN_SIGN_IN = "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";

/** A user cancelling a native sheet isn't an error worth showing. */
export const cancelled = (e: unknown) => /cancel/i.test(String((e as Error)?.message ?? e));
