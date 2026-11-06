import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot, showFatal } from "./boot";
import { hasAccount, isLinked, loadLocal, phoneState, refresh } from "./core/backend.phone";
import { Pair } from "./phone/Pair";
import { PhoneApp } from "./phone/PhoneApp";
import "./styles/phone.css";
import "./styles/phone-app.css";

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

const el = document.getElementById("root")!;
const root = createRoot(el);

function Message({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="pair">
      <img src="apple-touch-icon.png" alt="" className="pair-icon" />
      <p>{text}</p>
      {retry && (
        <button className="btn btn-primary" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}

async function start() {
  if (!(await isLinked())) {
    root.render(<Pair onDone={start} />);
    return;
  }
  if (!(await loadLocal().catch(() => false))) {
    // No copy on the phone yet: get the one in the cloud (or, for a new account, make it), showing each step.
    const t0 = Date.now();
    const show = () =>
      root.render(
        <Message
          text={`${phoneState.stage ?? "Getting your data from the cloud…"}${Date.now() - t0 > 15_000 ? ` (${Math.round((Date.now() - t0) / 1000)} s)` : ""}`}
          retry={Date.now() - t0 > 20_000 ? () => location.reload() : undefined}
        />,
      );
    show();
    const off = phoneState.onChange(show);
    const tick = window.setInterval(show, 1000);
    await refresh();
    off();
    window.clearInterval(tick);
    if (!phoneState.version) {
      root.render(
        <Message
          text={
            phoneState.error && (hasAccount() || !/Nothing has been sent/.test(phoneState.error))
              ? `Couldn't get your data from the cloud: ${phoneState.error}`
              : "The cloud has no copy from your PC yet. Open Command Centre on the PC (it sends a copy within a minute), then try again."
          }
          retry={start}
        />,
      );
      return;
    }
  }
  root.render(<Message text="Starting…" />);
  await boot({ withInit: false });
  root.render(
    <StrictMode>
      <PhoneApp />
    </StrictMode>,
  );
}

start().catch((e) => showFatal(el, e));
