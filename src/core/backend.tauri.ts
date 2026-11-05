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

  readDataFile: (name) => invoke("read_data_file", { name }),
  openStravaActivity: (id) => invoke("open_strava_activity", { id }),
  openGarminActivity: (id) => invoke("open_garmin_activity", { id }),
  writeDataFile: (name, contents) => invoke("write_data_file", { name, contents }),
  oauthStatus: (p) => invoke("oauth_status", { providerId: p }),
  oauthSetClient: (p, clientId, clientSecret) => invoke("oauth_set_client", { providerId: p, clientId, clientSecret }),
  oauthConnect: (p) => invoke("oauth_connect", { providerId: p }),
  oauthDisconnect: (p, forgetClient) => invoke("oauth_disconnect", { providerId: p, forgetClient }),
  apiRequest: (p, method, url, body) => invoke("api_request", { providerId: p, method, url, body: body ?? null }),
  icsList: () => invoke("ics_list"),
  icsAdd: (name, url) => invoke("ics_add", { name, url }),
  icsRemove: (id) => invoke("ics_remove", { id }),
  icsFetch: (id) => invoke("ics_fetch", { id }),
  garminStatus: () => invoke("garmin_status"),
  garminConnect: () => invoke("garmin_connect"),
  garminDisconnect: () => invoke("garmin_disconnect"),
  garminRequest: (path) => invoke("garmin_request", { path }),
  watchStatus: (folder, python) => invoke("watch_status", { folder, python }),
  watchConnect: (folder, python) => invoke("watch_connect", { folder, python }),
  watchCall: (name, args) => invoke("watch_call", { name, args }),
  watchDisconnect: () => invoke("watch_disconnect"),
  weatherFetch: (lat, lon) => invoke("weather_fetch", { lat, lon }),
  phoneLinkGet: () => invoke("phone_link_get"),
  phoneLinkSet: (link) => invoke("phone_link_set", { link }),
  phoneSnapshot: async () => new Uint8Array(await invoke<ArrayBuffer>("phone_snapshot")),
};
