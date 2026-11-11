import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/700.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot, showFatal } from "./boot";
import { Dashboard } from "./shell/Dashboard";
// The phone views the desktop shows too (training load, goals, Runalyze).
import "./styles/phone-app.css";
import "./styles/fit.css";

const root = document.getElementById("root")!;
boot({ withInit: true }).then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <Dashboard />
      </StrictMode>,
    ),
  (e) => showFatal(root, e),
);
