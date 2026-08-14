import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteAgentAdapter } from "./adapter-sqlite.js";
import { buildAgentConfig } from "./agent-config.js";

const db = openDb(":memory:");
const adapter = sqliteAgentAdapter(db);
function cfg(id: string, name: string, extra?: Partial<Parameters<typeof buildAgentConfig>[0]>) {
  return buildAgentConfig({
    id,
    name,
    model: { provider: "anthropic", model: "claude" },
    ...extra,
  });
}

describe("sqliteAgentAdapter", () => {
  test("create and findById roundtrip", async () => {
    const agent = await adapter.create({
      id: "a1",
      workspacePath: "/ws/a1",
      config: cfg("a1", "test"),
      now: 1000,
    });
    expect(agent.id).toBe("a1");
    expect(agent.config.name).toBe("test");
    expect(agent.config.runtime_config.permission_mode).toBe("ask");

    const found = await adapter.findById("a1");
    expect(found).not.toBeNull();
    expect(found?.workspacePath).toBe("/ws/a1");
  });

  test("findById returns null for unknown id", async () => {
    expect(await adapter.findById("nonexistent")).toBeNull();
  });

  test("list returns created agents", async () => {
    // Create 2 agents so we can assert on multiplicity independently
    await adapter.create({
      id: "b1",
      workspacePath: "/ws/b1",
      config: cfg("b1", "b1"),
      now: 2000,
    });
    await adapter.create({
      id: "b2",
      workspacePath: "/ws/b2",
      config: cfg("b2", "b2"),
      now: 2100,
    });
    const list = await adapter.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some((a) => a.id === "b1")).toBe(true);
    expect(list.some((a) => a.id === "b2")).toBe(true);
  });

  test("list excludes archived by default", async () => {
    await adapter.archive("b1", 3000);
    const list = await adapter.list();
    expect(list.some((a) => a.id === "b1")).toBe(false);
  });

  test("update modifies config", async () => {
    const updated = await adapter.update("a1", { config: cfg("a1", "renamed"), now: 4000 });
    expect(updated).not.toBeNull();
    expect(updated?.config.name).toBe("renamed");
  });

  test("update persists lark profile_ref", async () => {
    const updated = await adapter.update("a1", {
      config: cfg("a1", "test", { lark: { enabled: true } }),
      now: 5000,
    });
    expect(updated).not.toBeNull();
    expect(updated?.config.lark.profile_ref).toBe("agent:a1");
  });
});
