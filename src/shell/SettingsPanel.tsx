import { ACCENTS } from "../core/appearance";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { backend } from "@backend";
import type { AppConfig, BackupStatus, MonitorInfo } from "../core/backend.types";
import { getSettings, subscribeSettings, TEXT_SIZES, updateSettings } from "../core/settings";
import { Connections } from "./Connections";
import { PhoneSetting } from "./PhoneSetting";
import { TargetPrefs } from "../modules/running/TargetPrefs";
import { AutoSyncSetting } from "../modules/watch/AutoSyncSetting";
import { CalendarFeeds } from "../modules/calendar/Connect";
import { GarminSetting } from "../modules/health";
import { WatchSetting } from "../modules/watch";
import { getTaskSync, setTaskSyncEnabled } from "../modules/tasks/gsync";

function Row({ label, hint, children, path }: { label: string; hint?: string; children: ReactNode; path?: boolean }) {
  return (
    <div className="setting">
      <div>
        <div className="setting-label">{label}</div>
        {hint && <div className={"muted small" + (path ? " path" : "")}>{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button className={"toggle" + (on ? " on" : "")} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

const SECTIONS = [
  { id: "accounts", label: "Accounts", icon: "🔗" },
  { id: "training", label: "Training & watch", icon: "🏃" },
  { id: "phone", label: "Phone & cloud", icon: "📱" },
  { id: "calendar", label: "Calendars", icon: "📅" },
  { id: "display", label: "Display & behaviour", icon: "🖥" },
  { id: "data", label: "Data & backups", icon: "💾" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];
let lastSection: Section = "accounts";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [folder, setFolder] = useState("");
  const [version, setVersion] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [section, setSectionState] = useState<Section>(lastSection);
  const setSection = (x: Section) => {
    lastSection = x;
    setSectionState(x);
  };
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [taskSync, setTaskSync] = useState<boolean | null>(null);
  useEffect(() => {
    getTaskSync().then((s) => setTaskSync(s.enabled));
  }, []);

  const refresh = async () => {
    const [m, c, a, b, f, v] = await Promise.all([
      backend.listMonitors(),
      backend.getConfig(),
      backend.autostartEnabled().catch(() => false),
      backend.backupStatus(),
      backend.dataFolder(),
      backend.appVersion(),
    ]);
    setMonitors(m);
    setConfig(c);
    setShortcut((s) => s || c.quickAddShortcut);
    setAutostartState(a);
    setBackup(b);
    setFolder(f);
    setVersion(v);
  };

  useEffect(() => {
    refresh();
  }, []);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      setMsg(ok ? { text: ok } : null);
    } catch (e) {
      setMsg({ text: String((e as Error)?.message ?? e), error: true });
    }
    refresh();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((x) => (
              <button key={x.id} className={section === x.id ? "on" : ""} onClick={() => setSection(x.id)}>
                <span aria-hidden="true">{x.icon}</span> {x.label}
              </button>
            ))}
          </nav>
          <div className="settings-pane">
            {section === "accounts" && (
              <>
                <h3>Garmin</h3>
                <p className="muted small">Runs, health (sleep, HRV, Body Battery, readiness) and sending workouts to your watch.</p>
        <GarminSetting />
                <h3>Google, Strava and others</h3>
                <Connections />
        <Row label="Sync tasks with Google Tasks" hint="Projects become lists on your phone. Title, notes, due date, done and subtasks sync both ways.">
          {taskSync != null && (
            <Toggle on={taskSync} label="Sync tasks with Google Tasks" onChange={(v) => setTaskSyncEnabled(v).then(() => setTaskSync(v))} />
          )}
        </Row>

              </>
            )}
            {section === "calendar" && (
              <>
                <h3>Calendars</h3>
        <p className="muted small">The quick way: paste your calendar's secret iCal address.</p>
        <CalendarFeeds />
              </>
            )}
            {section === "training" && (
              <>
                <h3>Targets</h3>
                <p className="muted small">How runs are targeted and judged. Also on Training → Plan.</p>
                <TargetPrefs />
                <h3>Workouts on your watch</h3>
                <AutoSyncSetting />
                <WatchSetting />
              </>
            )}
            {section === "phone" && (
              <>
                <h3>Phone and cloud sync</h3>
                <PhoneSetting />
              </>
            )}
            {section === "display" && (
              <>
                <h3>Display</h3>
        <Row label="Show the dashboard on" hint="Remembered. If that screen sleeps or is unplugged, the dashboard minimises and comes back with it.">
          <div className="monitor-list">
            {monitors.map((m, i) => (
              <button key={`${m.name}-${m.x}-${m.y}`} className={"monitor" + (m.chosen ? " chosen" : "")} onClick={() => act(() => backend.setMonitor(m))}>
                <span className={"monitor-shape" + (m.height > m.width ? " portrait" : "")} />
                <span>
                  <strong>Screen {i + 1}</strong>
                  {m.primary && <span className="muted"> · main</span>}
                  <br />
                  <span className="muted small">
                    {m.width}×{m.height} · {m.height > m.width ? "portrait" : "landscape"} · {Math.round(m.scale * 100)}%
                  </span>
                </span>
              </button>
            ))}
          </div>
        </Row>
        <Row label="Full-screen" hint="F11 also toggles this.">
          {config && <Toggle on={config.fullscreen} label="Full-screen" onChange={(v) => act(() => backend.setFullscreen(v))} />}
        </Row>
        <Row label="Theme">
          <div className="segmented small-seg">
            {(["slate", "light", "dark", "system"] as const).map((t) => (
              <button key={t} className={settings.theme === t ? "on" : ""} onClick={() => updateSettings({ theme: t })}>
                {t === "slate" ? "Slate" : t === "light" ? "Light" : t === "dark" ? "Dark" : "Match Windows"}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Accent colour">
          <div className="accent-swatches">
            {[{ id: "", name: "Theme's own", dark: "var(--muted)", light: "" }, ...ACCENTS].map((a) => (
              <button key={a.id} className={"accent-swatch" + ((settings.accent ?? "") === a.id ? " on" : "")} style={{ ["--sw" as string]: a.dark }} title={a.name} aria-label={a.name} onClick={() => updateSettings({ accent: a.id || undefined })}>
                <i />
              </button>
            ))}
          </div>
        </Row>
        <Row label="Text size" hint="Text also scales with the width of the screen.">
          <div className="segmented small-seg">
            {TEXT_SIZES.map((t) => (
              <button key={t.value} className={settings.textScale === t.value ? "on" : ""} onClick={() => updateSettings({ textScale: t.value })}>
                {t.label}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Hide the mouse pointer when idle">
          <Toggle on={settings.hideCursor} label="Hide pointer" onChange={(v) => updateSettings({ hideCursor: v })} />
        </Row>

                <h3>Behaviour</h3>
        <Row label="Launch at login">
          {autostart != null && <Toggle on={autostart} label="Launch at login" onChange={(v) => act(() => backend.setAutostart(v))} />}
        </Row>
        <Row label="Quick-add shortcut" hint="Works from any app. Examples: Ctrl+Alt+Space, Ctrl+Shift+A, Alt+Q">
          <span className="inline">
            <input value={shortcut} onChange={(e) => setShortcut(e.target.value)} aria-label="Quick-add shortcut" style={{ width: "12em" }} />
            <button
              className="btn"
              disabled={!config || shortcut === config.quickAddShortcut}
              onClick={() => act(() => backend.setQuickAddShortcut(shortcut.trim()), "Shortcut saved.")}
            >
              Save
            </button>
          </span>
        </Row>
        <Row label="New day starts at" hint="The daily checklist resets and “today” moves on at this time.">
          <select value={settings.dayResetHour} onChange={(e) => updateSettings({ dayResetHour: Number(e.target.value) })} aria-label="New day starts at">
            {Array.from({ length: 9 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </Row>

              </>
            )}
            {section === "data" && (
              <>
                <h3>Data and backups</h3>
        <Row label="Data folder" hint={folder} path>
          <button className="btn" onClick={() => act(() => backend.openDataFolder())}>
            Open
          </button>
        </Row>
        <Row
          label="Backups"
          hint={backup ? (backup.latest ? `Daily, last 30 kept. Latest: ${backup.latest} (${backup.count} stored)` : "Daily, last 30 kept. None yet.") : ""}
        >
          <button className="btn" onClick={() => act(() => backend.backupNow(), "Backup saved.")}>
            Back up now
          </button>
        </Row>

              </>
            )}
          </div>
        </div>

        {msg && <div className={msg.error ? "error-note" : "ok-note"}>{msg.text}</div>}
        <footer className="muted small modal-footer">
          Command Centre {version} (built {typeof __BUILD__ === "string" ? __BUILD__ : "dev"}) · Ctrl+E edit layout · Ctrl+, settings · F11 full-screen
        </footer>
      </div>
    </div>
  );
}
