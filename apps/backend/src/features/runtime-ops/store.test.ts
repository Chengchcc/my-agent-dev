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
    test("telemetrySummary includes byAgent success rate and failure errors", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b1', 'c1', 'a1', ?, 'completed', 'k3', 1, ?, ?, ?)`,
      ).run(
        "r-ok",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        }),
        now - 5_000,
        now,
      );
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b2', 'c2', 'a1', ?, 'failed', 'k4', 1, ?, ?, ?)`,
      ).run(
        "r-fail",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "failed",
          error: "model timeout",
          usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.001 },
        }),
        now - 3_000,
        now,
      );

      const summary = store.telemetrySummary(now - 60_000);
      expect(summary.byAgent).toHaveLength(1);
      expect(summary.byAgent[0]).toMatchObject({
        agentId: "a1",
        runs: 2,
        completed: 1,
        failed: 1,
      });
      expect(summary.byAgent[0]!.successRate).toBeCloseTo(0.5);
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0]).toMatchObject({
        runId: "r-fail",
        status: "failed",
        error: "model timeout",
        agentId: "a1",
      });
      expect(summary.costByHour).toHaveLength(1);
      expect(summary.costByHour[0]!.costUsd).toBeCloseTo(0.002);
      expect(summary.costByHour[0]!.tokens).toBe(25);
      expect(summary.byModel).toHaveLength(1);
      expect(summary.byModel[0]).toMatchObject({
        modelId: "fake/m",
        runs: 2,
        completed: 1,
        failed: 1,
      });
      expect(summary.byModel[0]!.costUsd).toBeCloseTo(0.002);
      expect(summary.byModel[0]!.tokens).toBe(25);
      expect(summary.successRateByDay).toHaveLength(1);
      expect(summary.successRateByDay[0]!.runs).toBe(2);
      expect(summary.successRateByDay[0]!.completed).toBe(1);
      expect(summary.successRateByDay[0]!.failed).toBe(1);
      expect(summary.successRateByDay[0]!.successRate).toBeCloseTo(0.5);
      expect(summary.durationByDay).toHaveLength(1);
      expect(summary.durationByDay[0]!.runs).toBe(2);
      expect(summary.durationByDay[0]!.avgDurationMs).toBeCloseTo(4000);
      expect(summary.failureCauses).toHaveLength(1);
      expect(summary.failureCauses[0]).toEqual({ cause: "timeout", count: 1 });
    });
    test("telemetrySummary flags spinning runs", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'bsp', 'csp', 'asp', ?, 'completed', 'ksp', 1, ?, ?, ?)`,
      ).run(
        "r-spin",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 20, outputTokens: 0, costUsd: 0.01 },
        }),
        now - 120_000,
        now,
      );
      for (let i = 0; i < 8; i += 1) {
        store.appendRunEvent("r-spin", "native_tool_started", { toolName: "bash" });
      }

      const summary = store.telemetrySummary(now - 600_000);
      expect(summary.spinningRuns).toHaveLength(1);
      expect(summary.spinningRuns[0]).toMatchObject({
        runId: "r-spin",
        toolCalls: 8,
        durationMs: 120_000,
      });
    });
  });
});
