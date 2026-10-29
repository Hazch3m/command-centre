import { db, kvGet, kvSet } from "../../core/db";
import { notifyChanged } from "../../core/events";
import { addDays, todayKey } from "../../core/time";

export interface ChecklistItem {
  id: number;
  title: string;
  /** 1 for a simple tick; e.g. 3 for "3 hours of research". */
  target: number;
  /** Amount each tap adds when target > 1. */
  step: number;
  unit: string | null;
  sort: number;
}

export const migrations = [
  `CREATE TABLE checklist_items (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     target REAL NOT NULL DEFAULT 1,
     step REAL NOT NULL DEFAULT 1,
     unit TEXT,
     sort INTEGER NOT NULL DEFAULT 0,
     archived INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );
   CREATE TABLE checklist_log (
     item_id INTEGER NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
     day TEXT NOT NULL,
     value REAL NOT NULL,
     PRIMARY KEY (item_id, day)
   );`,
];

const TOPIC = "checklist";

/** First run only: the routine you mentioned. Edit or remove them in the card. */
export async function seedDefaults() {
  if (await kvGet("checklist.seeded", false)) return;
  const [{ n }] = await db.select<{ n: number }>("SELECT count(*) AS n FROM checklist_items");
  if (n === 0) {
    const now = new Date().toISOString();
    await db.batch([
      { sql: "INSERT INTO checklist_items (title, target, step, unit, sort, created_at) VALUES ('Stretching', 1, 1, NULL, 1, ?)", params: [now] },
      { sql: "INSERT INTO checklist_items (title, target, step, unit, sort, created_at) VALUES ('Reading', 1, 1, NULL, 2, ?)", params: [now] },
      { sql: "INSERT INTO checklist_items (title, target, step, unit, sort, created_at) VALUES ('Research', 3, 0.5, 'h', 3, ?)", params: [now] },
    ]);
  }
  await kvSet("checklist.seeded", true);
}

export interface ChecklistState {
  items: ChecklistItem[];
  /** Today's value per item id. */
  today: Map<number, number>;
  /** Completed days per item id (last ~2 years), for streaks. */
  doneDays: Map<number, string[]>;
}

export async function loadChecklist(today: string): Promise<ChecklistState> {
  const items = await db.select<ChecklistItem>("SELECT id, title, target, step, unit, sort FROM checklist_items WHERE archived = 0 ORDER BY sort, id");
  const todayRows = await db.select<{ item_id: number; value: number }>("SELECT item_id, value FROM checklist_log WHERE day = ?", [today]);
  const done = await db.select<{ item_id: number; day: string }>(
    `SELECT l.item_id, l.day FROM checklist_log l JOIN checklist_items i ON i.id = l.item_id
     WHERE l.value >= i.target AND l.day >= ? ORDER BY l.day`,
    [addDays(today, -730)],
  );
  const doneDays = new Map<number, string[]>();
  for (const r of done) {
    if (!doneDays.has(r.item_id)) doneDays.set(r.item_id, []);
    doneDays.get(r.item_id)!.push(r.day);
  }
  return { items, today: new Map(todayRows.map((r) => [r.item_id, r.value])), doneDays };
}

export async function setValue(itemId: number, value: number, day = todayKey()) {
  if (value <= 0) await db.execute("DELETE FROM checklist_log WHERE item_id = ? AND day = ?", [itemId, day]);
  else
    await db.execute(
      "INSERT INTO checklist_log (item_id, day, value) VALUES (?, ?, ?) ON CONFLICT(item_id, day) DO UPDATE SET value = excluded.value",
      [itemId, day, Math.round(value * 100) / 100],
    );
  await notifyChanged(TOPIC);
}

/**
 * "Meditate" → simple tick. "Research 3h" → target 3, unit h, half-hour steps.
 * "Pages 20" → target 20, steps of 5.
 */
export function parseItem(text: string): { title: string; target: number; step: number; unit: string | null } {
  const m = /^(.*?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]{1,8})?$/.exec(text.trim());
  if (!m || !m[1]) return { title: text.trim(), target: 1, step: 1, unit: null };
  const target = Number(m[2]);
  const unit = m[3] ? m[3].toLowerCase() : null;
  const step = unit === "h" || unit === "hr" || unit === "hrs" ? 0.5 : target >= 20 ? 5 : 1;
  return { title: m[1].trim(), target, step, unit };
}

export async function addItem(text: string) {
  const p = parseItem(text);
  if (!p.title) throw new Error("Give the item a name.");
  const [{ next }] = await db.select<{ next: number }>("SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM checklist_items");
  await db.execute("INSERT INTO checklist_items (title, target, step, unit, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    p.title,
    p.target,
    p.step,
    p.unit,
    next,
    new Date().toISOString(),
  ]);
  await notifyChanged(TOPIC);
}

export async function updateItem(id: number, text: string) {
  const p = parseItem(text);
  if (!p.title) throw new Error("Give the item a name.");
  await db.execute("UPDATE checklist_items SET title = ?, target = ?, step = ?, unit = ? WHERE id = ?", [p.title, p.target, p.step, p.unit, id]);
  await notifyChanged(TOPIC);
}

/** Archived items keep their history but leave the list. */
export async function archiveItem(id: number) {
  await db.execute("UPDATE checklist_items SET archived = 1 WHERE id = ?", [id]);
  await notifyChanged(TOPIC);
}

export async function moveItem(items: ChecklistItem[], index: number, delta: -1 | 1) {
  const j = index + delta;
  if (j < 0 || j >= items.length) return;
  const order = items.map((i) => i.id);
  [order[index], order[j]] = [order[j], order[index]];
  await db.batch(order.map((id, k) => ({ sql: "UPDATE checklist_items SET sort = ? WHERE id = ?", params: [k + 1, id] })));
  await notifyChanged(TOPIC);
}

export function itemText(i: ChecklistItem): string {
  return i.target === 1 && !i.unit ? i.title : `${i.title} ${i.target}${i.unit ?? ""}`;
}
