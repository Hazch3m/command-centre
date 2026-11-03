import { describe, expect, it } from "vitest";
import { cleanCode, linkKeys, newPairCode, newSecret, openWithCode, packSnapshot, phoneMayWrite, seal, sealForCode, unpackSnapshot, unseal, withPhoneId, writeTarget } from "./sync";

describe("phone link", () => {
  it("encrypts and decrypts with keys from the secret", async () => {
    const s = newSecret();
    const a = await linkKeys(s);
    const b = await linkKeys(s);
    expect(a.token).toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    const box = await seal(a.key, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await unseal(b.key, box))).toBe("hello");
    const other = await linkKeys(newSecret());
    await expect(unseal(other.key, box)).rejects.toBeTruthy();
  });
  it("passes the secret through a pairing code", async () => {
    const code = newPairCode();
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const blob = await sealForCode(code, "the-secret");
    expect(await openWithCode(code.toLowerCase().slice(0, 4) + "-" + code.slice(4), blob)).toBe("the-secret");
    expect(cleanCode(" ab-cd ef12 ")).toBe("ABCDEF12");
  });
  it("packs a snapshot", () => {
    const db = new Uint8Array([1, 2, 3]);
    const h = { v: 1 as const, made: "x", files: { "a.json": "{}" }, connected: { strava: true, google: false, garmin: true }, ics: [], applied: 7 };
    const back = unpackSnapshot(packSnapshot(h, db));
    expect(back.header.applied).toBe(7);
    expect([...back.db]).toEqual([1, 2, 3]);
  });
  it("only lets the phone change its own tables", () => {
    expect(writeTarget("INSERT OR REPLACE INTO plan_overrides (date, text) VALUES (?, ?)")).toBe("plan_overrides");
    expect(phoneMayWrite("UPDATE tasks SET done_at = ? WHERE id = ?", ["x", 1])).toBe(true);
    expect(phoneMayWrite("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["calendar.view.page", "1"])).toBe(true);
    expect(phoneMayWrite("INSERT INTO kv (key, value) VALUES (?, ?)", ["health.sync", "1"])).toBe(false);
    expect(phoneMayWrite("INSERT INTO health_daily (date) VALUES (?)", ["x"])).toBe(false);
    expect(phoneMayWrite("DELETE FROM tasks; DROP TABLE kv", [])).toBe(false);
  });
  it("gives new phone rows their own ids", () => {
    const r = withPhoneId("INSERT INTO tasks (title, created_at) VALUES (?, ?)", ["a", "b"]);
    expect(r.sql).toBe("INSERT INTO tasks (id, title, created_at) VALUES (?, ?, ?)");
    expect(r.params[0]).toBeGreaterThan(1e15);
    expect(withPhoneId("INSERT INTO tasks (id, title) VALUES (?, ?)", [1, "a"]).params).toEqual([1, "a"]);
  });
});
