import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { backend } from "@backend";
import type { AppConfig, BackupStatus, MonitorInfo } from "../core/backend.types";
import { getSettings, subscribeSettings, updateSettings } from "../core/settings";
import { Connections } from "./Connections";

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

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useSyncExternalStore(subscribeSettings, getSettings);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [folder, setFolder] = useState("");
  const [version, setVersion] = useState("");
  const [shortcut, setShortcut] = useState("");
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

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
      <div className="modal" role="dialog" aria-label="Settings">
        <header className="modal-header">
          <h2>Settings</h2>
          <button className="btn icon ghost" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </header>

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

        <h3>Connections</h3>
        <Connections />

        <h3>Data</h3>
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

        {msg && <div className={msg.error ? "error-note" : "ok-note"}>{msg.text}</div>}
        <footer className="muted small modal-footer">
          Command Centre {version} · Ctrl+E edit layout · Ctrl+, settings · F11 full-screen
        </footer>
      </div>
    </div>
  );
}
