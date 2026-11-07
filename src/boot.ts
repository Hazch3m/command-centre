import "@fontsource-variable/inter";
import "./styles/theme.css";
import { runMigrations } from "./core/db";
import { loadSettings } from "./core/settings";
import { modules } from "./modules/registry";

/** Shared start-up for both windows: schema, settings, first-run seeding. */
export async function boot({ withInit }: { withInit: boolean }) {
  await runMigrations(modules);
  await loadSettings();
  if (withInit) for (const m of modules) await m.init?.();
}

export function showFatal(root: HTMLElement, err: unknown) {
  root.innerHTML = "";
  const box = document.createElement("div");
  box.className = "fatal";
  box.innerHTML = "<h1>Pacelife couldn't start</h1><p>The error below is also in the log file. Your data has not been touched.</p>";
  const pre = document.createElement("pre");
  pre.textContent = String((err as Error)?.stack ?? err);
  box.appendChild(pre);
  root.appendChild(box);
}
