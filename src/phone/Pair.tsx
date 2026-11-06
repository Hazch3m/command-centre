import { useState } from "react";
import { cleanCode } from "../core/sync";
import { pairWithCode } from "../core/backend.phone";

/** Opened from the home screen, or inside the Command Centre iPhone app (which needs no "add to home screen"). */
const standalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia?.("(display-mode: standalone)").matches ||
  /CommandCentreApp/.test(navigator.userAgent) ||
  !!(window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** First run: link this phone to the PC with the code shown in Settings → Phone. */
export function Pair({ onDone }: { onDone: () => void }) {
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
