import { backend } from "@backend";
import type { SqlParam } from "./backend.types";

export const db = {
  select: backend.select.bind(backend),
  execute: backend.execute.bind(backend),
  batch: backend.batch.bind(backend),
};

/**
 * Runs each card's migrations once, in order. Migration ids are
 * `<moduleId>:<index>`, so append new migrations to the end of a module's list;
 * never edit or reorder ones that have shipped.
 */
export async function runMigrations(modules: { id: string; migrations?: string[] }[]) {
  const done = new Set((await db.select<{ id: string }>("SELECT id FROM _migrations")).map((r) => r.id));
  for (const m of modules) {
    for (const [i, sql] of (m.migrations ?? []).entries()) {
      const id = `${m.id}:${i}`;
      if (done.has(id)) continue;
      await db.batch([
        { sql },
        { sql: "INSERT INTO _migrations (id, applied_at) VALUES (?, ?)", params: [id, new Date().toISOString()] },
      ]);
    }
  }
}

export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  const rows = await db.select<{ value: string }>("SELECT value FROM kv WHERE key = ?", [key]);
  if (!rows.length) return fallback;
  try {
    return JSON.parse(rows[0].value) as T;
  } catch {
    return fallback;
  }
}

export async function kvSet(key: string, value: unknown) {
  await db.execute(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, JSON.stringify(value)] as SqlParam[],
  );
}
