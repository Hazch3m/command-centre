/** Everything the UI needs from the host. Implemented by Tauri (real app) and sql.js (browser harness). */

export type SqlParam = string | number | boolean | null;
export type Row = Record<string, unknown>;
export interface ExecResult {
  changes: number;
  lastInsertId: number;
}
export interface Statement {
  sql: string;
  params?: SqlParam[];
}

export interface MonitorInfo {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  primary: boolean;
  current: boolean;
  chosen: boolean;
}

export interface AppConfig {
  monitor: { name: string; x: number; y: number; width: number; height: number } | null;
  quickAddShortcut: string;
  fullscreen: boolean;
}

export interface BackupStatus {
  folder: string;
  latest: string | null;
  count: number;
}

export type Provider = "strava" | "google";
export interface OAuthStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
}
export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

export interface Backend {
  readonly kind: "tauri" | "browser";
  select<T = Row>(sql: string, params?: SqlParam[]): Promise<T[]>;
  execute(sql: string, params?: SqlParam[]): Promise<ExecResult>;
  batch(statements: Statement[]): Promise<ExecResult[]>;

  /** Broadcast to every window (dashboard + quick-add). */
  emit(event: string, payload?: unknown): Promise<void>;
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;

  // Host features
  getConfig(): Promise<AppConfig>;
  listMonitors(): Promise<MonitorInfo[]>;
  setMonitor(m: MonitorInfo): Promise<void>;
  setFullscreen(on: boolean): Promise<void>;
  setQuickAddShortcut(shortcut: string): Promise<void>;
  hideQuickAdd(): Promise<void>;
  autostartEnabled(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  backupStatus(): Promise<BackupStatus>;
  backupNow(): Promise<BackupStatus>;
  dataFolder(): Promise<string>;
  openDataFolder(): Promise<void>;
  appVersion(): Promise<string>;

  /** JSON files in the data folder that people edit by hand (e.g. training-plan.json). */
  readDataFile(name: string): Promise<string | null>;
  openStravaActivity(id: string): Promise<void>;
  writeDataFile(name: string, contents: string): Promise<void>;

  // Sign-in and authenticated API calls (tokens stay in the OS keychain).
  oauthStatus(p: Provider): Promise<OAuthStatus>;
  oauthSetClient(p: Provider, clientId: string, clientSecret: string): Promise<void>;
  oauthConnect(p: Provider): Promise<OAuthStatus>;
  oauthDisconnect(p: Provider, forgetClient: boolean): Promise<void>;
  /** Rejects with a message starting "offline:" when there's no connection. */
  apiRequest<T = unknown>(p: Provider, method: string, url: string, body?: unknown): Promise<ApiResponse<T>>;

  // Calendar feeds by secret iCal address (the address is kept in the keychain).
  icsList(): Promise<{ id: string; name: string; host: string }[]>;
  icsAdd(name: string, url: string): Promise<void>;
  icsRemove(id: string): Promise<void>;
  /** The feed's text. Rejects with "offline: …" when there's no connection. */
  icsFetch(id: string): Promise<string>;

  // Garmin Connect (health metrics). Sign-in happens on Garmin's own page in a separate window.
  garminStatus(): Promise<{ connected: boolean }>;
  garminConnect(): Promise<{ connected: boolean }>;
  garminDisconnect(): Promise<void>;
  /** GET a read-only health endpoint. Rejects with "offline: …" when there's no connection. */
  garminRequest<T = unknown>(path: string): Promise<{ status: number; body: T }>;
}
