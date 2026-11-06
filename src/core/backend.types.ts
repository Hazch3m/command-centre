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
  readonly kind: "tauri" | "browser" | "phone";
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
  /** Opens a run in Garmin Connect (numeric activity id). */
  openGarminActivity(id: string): Promise<void>;
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
  /** Creates, changes, schedules or removes a workout on Garmin Connect (it reaches the watch on its next sync). */
  garminWrite<T = unknown>(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<{ status: number; body: T }>;
  /** Cloud sync: the sign-ins to hand to the sync service (PC only). */
  cloudCredentials(): Promise<{ garmin: unknown; google: unknown; ics: { id: string; name: string; url: string }[] }>;
  /** Cloud sync off: keeps the sign-ins the service hands back (Garmin's may have been refreshed there). */
  cloudRestore(garmin: unknown, google: unknown): Promise<void>;
  // ---- Watch: the user's garmin-coach MCP server, run as a child process ----
  /** Empty folder/python = find them (the folder's .venv). */
  watchStatus(folder: string, python: string): Promise<WatchStatus>;
  /** Starts garmin-coach if needed; returns its tools (name, description, inputSchema). */
  watchConnect(folder: string, python: string): Promise<McpTool[]>;
  /** Calls one tool; the raw MCP CallToolResult. */
  watchCall(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  watchDisconnect(): Promise<void>;

  /** Open-Meteo forecast. Rejects with "offline: …" when there's no connection. */
  weatherFetch(lat: number, lon: number): Promise<unknown>;

  // ---- Phone link (cloud sync) ----
  /** The sync service address and the link's secret (kept in the keychain). */
  phoneLinkGet(): Promise<PhoneLink | null>;
  phoneLinkSet(link: PhoneLink | null): Promise<void>;
  /** A copy of the database for the phone (SQLite file bytes, big run streams left out). */
  phoneSnapshot(): Promise<Uint8Array>;
}

export interface PhoneLink {
  url: string;
  secret: string;
}

export interface WatchStatus {
  folder: string;
  serverFound: boolean;
  python: string | null;
  tokensFound: boolean;
  tokensDir: string;
  running: boolean;
  stderr: string[];
}
export interface McpTool {
  name: string;
  description?: string;
  inputSchema: { type?: string; properties?: Record<string, { type?: string; default?: unknown; anyOf?: unknown[] }>; required?: string[] };
}
export interface McpCallResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}
