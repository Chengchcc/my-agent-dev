import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { Session } from "./session.js";
import { memorySessionStorage } from "./memory-session-storage.js";
import { sqliteSessionStorage } from "./sqlite-session-storage.js";

const u = (text: string): Message => ({ role: "user", text });
const a = (text: string): Message => ({ role: "assistant", text });

const fixture = (storage: ReturnType<typeof memorySessionStorage>) => {
  const s = new Session(storage);
  return s;
};

describe("Session (memory)", () => {
  test("appendMessage + buildContext roundtrip", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("hello"));
    await s.appendMessage(a("world"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["hello", "world"]);
  });

  test("moveTo forks from existing node", async () => {
    const s = fixture(memorySessionStorage());
    const id1 = await s.appendMessage(u("a"));
    await s.appendMessage(a("b"));
    // fork from id1
    await s.moveTo(id1);
    await s.appendMessage(a("b2"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["a", "b2"]);
  });

  test("moveTo null resets to empty", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("a"));
    await s.moveTo(null);
    const ctx = await s.buildContext();
    expect(ctx.messages).toEqual([]);
  });

  test("moveTo throws on missing entry", async () => {
    const s = fixture(memorySessionStorage());
    await expect(s.moveTo("nope")).rejects.toThrow("not found");
  });

  test("appendCompaction truncates and prepends summary", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("old1"));
    const id2 = await s.appendMessage(u("old2"));
    // firstKeptEntryId=id2: old1 compressed away, old2 kept
    await s.appendCompaction("summary of old", id2, 100);
    await s.appendMessage(a("after"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["summary of old", "old2", "after"]);
    expect(ctx.messages[0]?.role).toBe("system");
  });

  test("appendModelChange sets context.model", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("hi"));
    await s.appendModelChange("openai", "gpt-4");
    const ctx = await s.buildContext();
    expect(ctx.model).toEqual({ provider: "openai", modelId: "gpt-4" });
  });

  test("getBranch returns path slice", async () => {
    const s = fixture(memorySessionStorage());
    const id1 = await s.appendMessage(u("a"));
    const id2 = await s.appendMessage(a("b"));
    const branch = await s.getBranch(id1);
    expect(branch.map((e) => e.id)).toEqual([id1, id2]);
  });

  test("getBranch throws if not on path", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("a"));
    await expect(s.getBranch("nope")).rejects.toThrow("not on current path");
  });

  test("appendCompaction with unknown firstKeptEntryId keeps all tail", async () => {
    const s = fixture(memorySessionStorage());
    await s.appendMessage(u("m1"));
    await s.appendCompaction("sum", "unknown-id", 50);
    await s.appendMessage(a("m2"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["sum", "m2"]);
  });
});

describe("Session (sqlite)", () => {
  test("appendMessage + buildContext roundtrip", async () => {
    const db = new Database(":memory:");
    const storage = sqliteSessionStorage({ db, sessionId: "s1" });
    const s = new Session(storage);
    await s.appendMessage(u("hello"));
    await s.appendMessage(a("world"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["hello", "world"]);
  });

  test("fork across sessions isolated", async () => {
    const db = new Database(":memory:");
    const s1 = new Session(sqliteSessionStorage({ db, sessionId: "s1" }));
    const s2 = new Session(sqliteSessionStorage({ db, sessionId: "s2" }));
    await s1.appendMessage(u("a1"));
    await s2.appendMessage(u("b1"));
    const c1 = await s1.buildContext();
    const c2 = await s2.buildContext();
    expect(c1.messages.map((m) => m.text)).toEqual(["a1"]);
    expect(c2.messages.map((m) => m.text)).toEqual(["b1"]);
  });

  test("moveTo + appendCompaction in sqlite", async () => {
    const db = new Database(":memory:");
    const storage = sqliteSessionStorage({ db, sessionId: "s1" });
    const s = new Session(storage);
    await s.appendMessage(u("old1"));
    const id2 = await s.appendMessage(u("old2"));
    await s.appendCompaction("sum", id2, 100);
    await s.appendMessage(a("after"));
    const ctx = await s.buildContext();
    expect(ctx.messages.map((m) => m.text)).toEqual(["sum", "old2", "after"]);
  });

  test("reopening storage persists leaf + entries", async () => {
    const path = `/tmp/test-session-sqlite-${Date.now()}.sqlite`;
    {
      const db = new Database(path);
      const storage = sqliteSessionStorage({ db, sessionId: "s1" });
      const s = new Session(storage);
      await s.appendMessage(u("persisted"));
      db.close();
    }
    {
      const db = new Database(path);
      const storage = sqliteSessionStorage({ db, sessionId: "s1" });
      const s = new Session(storage);
      const ctx = await s.buildContext();
      expect(ctx.messages.map((m) => m.text)).toEqual(["persisted"]);
      db.close();
    }
  });
});
