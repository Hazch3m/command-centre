import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { boot, showFatal } from "./boot";
import { QuickAdd } from "./shell/QuickAdd";

const root = document.getElementById("root")!;
// The dashboard window creates the tables; retry briefly in case this window loads first.
async function start(attempt = 0): Promise<void> {
  try {
    await boot({ withInit: false });
  } catch (e) {
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 500));
      return start(attempt + 1);
    }
    throw e;
  }
}
start().then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <QuickAdd />
      </StrictMode>,
    ),
  (e) => showFatal(root, e),
);
