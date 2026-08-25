import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { RuntimeOpsStore } from "./store.js";

function createTestDb() {
  return openDb(":memory:");
}

describe("RuntimeOpsStore", () => {
  let db: Database;
  let store: RuntimeOpsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RuntimeOpsStore(db);
  });

  afterEach(() => db.close());

  describe("surface_health", () => {
    test("upsert and get", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: { watchers: { conversation: 3 } },
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health).toBeDefined();
      expect(health!.status).toBe("running");
    });

    test("getSurfaceHealthsForAgent", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });

      expect(store.getSurfaceHealthsForAgent("agent_x")).toHaveLength(1);
    });

    test("upsertSurfaceHealth updates existing", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "degraded",
        payload: { error: "card failed" },
        lastError: "card update failed",
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health!.status).toBe("degraded");
      expect(health!.lastError).toBe("card update failed");
    });

    test("listSurfaceHealths orders by agentId then surface", () => {
      store.upsertSurfaceHealth({ agentId: "b", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "web", status: "ok", payload: {} });

      const rows = store.listSurfaceHealths();
      expect(rows.map((r) => `${r.agentId}/${r.surface}`)).toEqual(["a/lark", "a/web", "b/lark"]);
    });
  });

  describe("agent_run_event / telemetry", () => {
    beforeEach(() => {
      // These tests insert agent_run rows directly; the FK chain (member ->
      // tree -> branch -> run) is out of scope for store unit tests.
      db.exec("PRAGMA foreign_keys = OFF");
    });

    afterEach(() => db.exec("PRAGMA foreign_keys = ON"));

    test("appendRunEvent + listRunEvents round-trip", () => {
      store.appendRunEvent("r1", "native_tool_started", { toolName: "bash" });
      store.appendRunEvent("r1", "status", { status: "completed" });

      const events = store.listRunEvents("r1");
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("native_tool_started");
      expect(events[0]!.data).toEqual({ toolName: "bash" });
      expect(events[0]!.ts).toBeGreaterThan(0);
    });

    test("telemetrySummary aggregates runs, usage and tool calls", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b1', 'c1', 'm1', ?, 'completed', 'k1', 1, ?, ?, ?)`,
      ).run(
        "r-agg",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
        }),
        now - 5_000,
        now,
      );
      store.appendRunEvent("r-agg", "native_tool_started", { toolName: "bash" });
      store.appendRunEvent("r-agg", "native_tool_started", { toolName: "grep" });
      store.appendRunEvent("r-agg", "text_delta", { text: "ignored" }); // not counted

      const summary = store.telemetrySummary(now - 60_000);
      expect(summary.runs).toBe(1);
      expect(summary.inputTokens).toBe(100);
      expect(summary.outputTokens).toBe(50);
      expect(summary.costUsd).toBeCloseTo(0.01);
      expect(summary.toolCalls).toBe(2); // text_delta not counted
      expect(summary.avgDurationMs).toBe(5000);
      expect(summary.recent).toHaveLength(1);
      expect(summary.recent[0]!.modelId).toBe("fake/m");
      expect(summary.recent[0]!.toolCalls).toBe(2);
      expect(summary.recent[0]!.durationMs).toBe(5000);
    });

    test("telemetrySummary respects the since window", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
         VALUES (?, 'b2', 'c2', 'm2', ?, 'completed', 'k2', 1, ?)`,
      ).run("old", JSON.stringify({ backendKind: "oma", modelId: "fake/m" }), now - 86_400_000 * 2);

      const summary = store.telemetrySummary(now - 86_400_000);
      expect(summary.runs).toBe(0);
    });
  });
});
