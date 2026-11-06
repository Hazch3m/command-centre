/**
 * The iPhone app's own abilities (mobile/ios-plugin): Sign in with Apple, and
 * Garmin's sign-in page in a window of its own that hands back Garmin's ticket.
 * In a browser these aren't there; the phone app then offers a pairing code.
 */
interface CCNative {
  signInWithApple(o: { nonce: string }): Promise<{ identityToken: string; email?: string | null; name?: string | null }>;
  garminLogin(o: { url: string }): Promise<{ ticket: string }>;
}
type Cap = {
  isNativePlatform?: () => boolean;
  registerPlugin?: <T>(name: string) => T;
  /** Injected by the iPhone app's bridge itself (no Capacitor library needed in the page). */
  nativePromise?: <T>(plugin: string, method: string, options: unknown) => Promise<T>;
};

const cap = () => (globalThis as unknown as { Capacitor?: Cap }).Capacitor;

/** Inside the iPhone app (not a browser)? */
export const isNativeApp = () => !!cap()?.isNativePlatform?.() || /CommandCentreApp/.test(globalThis.navigator?.userAgent ?? "");

let plugin: CCNative | null = null;
/** The app's native plugin, called through the bridge the app injects into the page. */
export function native(): CCNative {
  if (plugin) return plugin;
  const c = cap();
  if (c?.nativePromise) {
    const call = <T,>(method: string) => (o: unknown) => c.nativePromise!<T>("CCNative", method, o);
    plugin = { signInWithApple: call("signInWithApple"), garminLogin: call("garminLogin") } as CCNative;
  } else if (c?.registerPlugin) plugin = c.registerPlugin<CCNative>("CCNative");
  else throw new Error(isNativeApp() ? "This version of the app can't do this yet: update Command Centre in TestFlight." : "This needs the Command Centre iPhone app.");
  return plugin;
}

/** Garmin's sign-in page; ends with a redirect to connect.garmin.com/app?ticket=… */
export const GARMIN_SIGN_IN = "https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";

/** A user cancelling a native sheet isn't an error worth showing. */
export const cancelled = (e: unknown) => /cancel/i.test(String((e as Error)?.message ?? e));
