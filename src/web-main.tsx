import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import { StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { boot, showFatal } from "./boot";
import { isLinked, loadLocal, phoneState, refresh, signInWithAppleWeb } from "./core/backend.phone";
import { PhoneApp } from "./phone/PhoneApp";
import { applyPhoneLook } from "./core/appearance";
import "./styles/phone.css";
import "./styles/phone-app.css";
import "./styles/glass.css";
import "./styles/wide.css";
import "./styles/web.css";

/**
 * Pacelife on the web (pacelife.run/web): the desktop view of your account, for looking at the
 * plan, runs and Runalyze-style analysis on a big screen. Same account and data as the iPhone app.
 */
// The same app as on the iPhone, laid out for a computer, in your colours from the first frame.
applyPhoneLook();
const el = document.getElementById("root")!;
const root = createRoot(el);

function Box({ children }: { children: ReactNode }) {
  return (
    <div className="web-box">
      <img src="icon-192.png" alt="" />
      {children}
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Box>
      <h1>Pacelife</h1>
      <p>Your training plan, runs and analysis on a big screen. Sign in with the Apple ID you use in the Pacelife iPhone app.</p>
      <button
        className="web-apple"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            await signInWithAppleWeb();
            onDone();
          } catch (e) {
            setErr(String((e as Error)?.message ?? e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Waiting for Apple… (finish in the window that opened)" : "Sign in with Apple"}
      </button>
      {err && <p className="web-err">{err}</p>}
      <p className="web-small">
        New to Pacelife? It starts on iPhone: <a href="/about">see what it does</a>.
      </p>
    </Box>
  );
}

async function start() {
  if (!(await isLinked())) {
    root.render(<SignIn onDone={start} />);
    return;
  }
  root.render(
    <Box>
      <p>Getting your data…</p>
    </Box>,
  );
  if (!(await loadLocal().catch(() => false))) {
    await refresh();
    if (!phoneState.version) {
      root.render(
        <Box>
          <p>Couldn't get your data: {phoneState.error ?? "nothing in your account yet"}. Set Pacelife up in the iPhone app first, then reload this page.</p>
        </Box>,
      );
      return;
    }
  } else refresh().catch(() => {});
  await boot({ withInit: false });
  root.render(
    <StrictMode>
      <PhoneApp wide />
    </StrictMode>,
  );
}

start().catch((e) => showFatal(el, e));
