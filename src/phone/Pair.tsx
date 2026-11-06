import { useState } from "react";
import { cleanCode } from "../core/sync";
import { pairWithCode, signInWithApple } from "../core/backend.phone";
import { cancelled, isNativeApp } from "../core/native";

/** Opened from the home screen, or inside the Command Centre iPhone app (which needs no "add to home screen"). */
const standalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia?.("(display-mode: standalone)").matches ||
  /CommandCentreApp/.test(navigator.userAgent) ||
  !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** First run in the iPhone app: Sign in with Apple (your own account, no PC needed), or a PC's code. */
export function Pair({ onDone }: { onDone: () => void }) {
  const [withCode, setWithCode] = useState(false);
  if (isNativeApp() && !withCode) return <SignIn onDone={onDone} useCode={() => setWithCode(true)} />;
  return <PairWithCode onDone={onDone} />;
}

function SignIn({ onDone, useCode }: { onDone: () => void; useCode: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await signInWithApple();
      onDone();
    } catch (e) {
      if (!cancelled(e)) setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pair signin">
      <img src="apple-touch-icon.png" alt="" className="pair-icon" />
      <h1>Command Centre</h1>
      <p>Your training plan, runs, PBs, fitness and health in one place, synced from Garmin and sent to your watch.</p>
      <button className="apple-btn" disabled={busy} onClick={go}>
        <svg viewBox="0 0 17 20" width="17" height="20" aria-hidden="true">
          <path fill="currentColor" d="M14.04 10.62c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.65.8-3.33.8-.7 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.19-1.55 2.68-.4 6.64 1.1 8.82.74 1.06 1.61 2.26 2.76 2.21 1.11-.04 1.53-.71 2.87-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.95-1.08 2.68-2.15.85-1.23 1.19-2.43 1.21-2.49-.03-.01-2.33-.89-2.38-3.56zM11.84 4.17c.6-.74 1.01-1.75.9-2.77-.87.04-1.94.59-2.56 1.32-.56.64-1.05 1.68-.92 2.67.98.07 1.97-.49 2.58-1.22z" />
        </svg>
        {busy ? "Signing in…" : "Sign in with Apple"}
      </button>
      {err && <div className="error-note">{err}</div>}
      <p className="muted small">Your account and data are kept on Command Centre's sync service so it can fetch from Garmin with your phone locked. Nothing is shared with anyone.</p>
      <button className="p-link" onClick={useCode}>
        Link to Command Centre on a PC with a code instead
      </button>
    </div>
  );
}

/** Link this phone to the PC with the code shown in Settings → Phone. */
function PairWithCode({ onDone }: { onDone: () => void }) {
  const fromLink = /pair=([A-Za-z0-9-]+)/.exec(location.hash)?.[1] ?? "";
  const [code, setCode] = useState(fromLink);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [here, setHere] = useState(standalone() || !isIos());
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await pairWithCode(code);
      history.replaceState(null, "", location.pathname);
      onDone();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pair">
      <img src="apple-touch-icon.png" alt="" className="pair-icon" />
      <h1>Command Centre</h1>
      {!here ? (
        <>
          <p>Put it on your home screen first, so it opens full-screen like an app:</p>
          <ol>
            <li>
              Tap <b>Share</b> (the square with the arrow) at the bottom of Safari.
            </li>
            <li>
              Choose <b>Add to Home Screen</b>, then <b>Add</b>.
            </li>
            <li>Open Command Centre from your home screen and enter the code from your PC.</li>
          </ol>
          {fromLink && (
            <p className="muted">
              Your code: <b className="num">{fromLink}</b>
            </p>
          )}
          <button className="btn ghost" onClick={() => setHere(true)}>
            Use it in Safari instead
          </button>
        </>
      ) : (
        <>
          <p>Enter the code shown on your PC in Settings → Phone → Link a phone.</p>
          <input
            className="pair-code num"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-EF23"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            spellCheck={false}
            inputMode="text"
          />
          <button className="btn btn-primary pair-go" disabled={busy || cleanCode(code).length !== 8} onClick={go}>
            {busy ? "Linking…" : "Link this phone"}
          </button>
          {err && <div className="error-note">{err}</div>}
          <p className="muted small">Your data is encrypted on the PC before it's sent; the sync service can't read it.</p>
        </>
      )}
    </div>
  );
}
