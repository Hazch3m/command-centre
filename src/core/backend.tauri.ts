import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { Backend } from "./backend.types";

export const backend: Backend = {
  kind: "tauri",
  select: (sql, params = []) => invoke("db_select", { sql, params }),
  execute: (sql, params = []) => invoke("db_execute", { sql, params }),
  batch: (statements) => invoke("db_batch", { statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })) }),

  emit: (event, payload) => emit(event, payload),
  listen: async (event, cb) => listen(event, (e) => cb(e.payload)),

  getConfig: () => invoke("get_config"),
  listMonitors: () => invoke("list_monitors"),
  setMonitor: (m) => invoke("set_monitor", { name: m.name, x: m.x, y: m.y }),
  setFullscreen: (on) => invoke("set_fullscreen_mode", { fullscreen: on }),
  setQuickAddShortcut: (shortcut) => invoke("set_quick_add_shortcut", { shortcut }),
  hideQuickAdd: () => invoke("hide_quick_add"),
  autostartEnabled: () => isEnabled(),
  setAutostart: (on) => (on ? enable() : disable()),
  backupStatus: () => invoke("backup_status"),
  backupNow: () => invoke("backup_now"),
  dataFolder: () => invoke("data_folder"),
  openDataFolder: () => invoke("open_data_folder"),
  appVersion: () => invoke("app_version"),
};
