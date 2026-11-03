import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot, showFatal } from "./boot";
import { isLinked, loadLocal, phoneState, refresh } from "./core/backend.phone";
import { Pair } from "./phone/Pair";
import { PhoneApp } from "./phone/PhoneApp";
import "./styles/phone.css";

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
  if (!(await loadLocal())) {
    root.render(<Message text="Fetching your dashboard from the PC…" />);
    await refresh();
    if (!phoneState.version) {
      root.render(<Message text="Nothing has arrived from the PC yet. Open Command Centre on the PC (it sends a copy within a minute), then try again." retry={start} />);
      return;
    }
  }
  await boot({ withInit: false });
  root.render(
    <StrictMode>
      <PhoneApp />
    </StrictMode>,
  );
}

start().catch((e) => showFatal(el, e));
