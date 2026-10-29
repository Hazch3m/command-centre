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
}
