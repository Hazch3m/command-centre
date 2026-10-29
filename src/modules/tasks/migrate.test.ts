import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { migrations } from "./data";

// Upgrading a Stage 1 database (what's installed today) must keep every task.
describe("tasks migrations", () => {
  it("upgrades Stage 1 data without losing anything", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(migrations[0]);
    db.exec(`INSERT INTO tasks (title, project, priority, due, created_at) VALUES
      ('Email supervisor', 'thesis', 1, '2026-10-30', '2026-10-29T10:00:00Z'),
      ('Submit form', 'thesis', 2, NULL, '2026-10-29T10:01:00Z'),
      ('Book physio', NULL, NULL, '2026-10-30', '2026-10-29T10:02:00Z');
      INSERT INTO tasks (title, project, done_at, done_day, created_at) VALUES ('Old done', 'lab', '2026-10-29T11:00:00Z', '2026-10-29', '2026-10-28T09:00:00Z');`);
    db.exec(migrations[1]);

    const rows = db.exec(`SELECT t.title, p.name, t.status, t.priority, t.due FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ORDER BY t.id`)[0].values;
    expect(rows).toEqual([
      ["Email supervisor", "thesis", "todo", 1, "2026-10-30"],
      ["Submit form", "thesis", "todo", 2, null],
      ["Book physio", null, "todo", null, "2026-10-30"],
      ["Old done", "lab", "done", null, null],
    ]);
    const projects = db.exec("SELECT name, color FROM projects ORDER BY sort")[0].values;
    expect(projects.map((p) => p[0]).sort()).toEqual(["lab", "thesis"]);
    expect(projects.every((p) => /^#[0-9a-f]{6}$/.test(String(p[1])))).toBe(true);
  });
});
