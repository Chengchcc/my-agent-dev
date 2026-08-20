import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentRun } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { CronJobService } from "../cron/service.js";
import { runLoopDoctor } from "./loop-doctor.js";
import { createLoopStateStore, type LoopStateStore } from "./loop-state-store.js";

function makeStore(): LoopStateStore {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE loop_item(
      loop_id TEXT NOT NULL, item_id TEXT NOT NULL,
      source TEXT NOT NULL, summary TEXT NOT NULL,
      step TEXT NOT NULL, attempt INTEGER NOT NULL,
      priority INTEGER NOT NULL, result TEXT,
      generator_run_id TEXT, evaluator_run_id TEXT,
      task_class TEXT, defer TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(loop_id, item_id)
    );
    CREATE TABLE loop_budget(
      loop_id TEXT NOT NULL, day TEXT NOT NULL,
      spent INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(loop_id, day)
    );
  `);
  return createLoopStateStore(db);
}

interface DoctorHarness {
  store: LoopStateStore;
  cronSvc: CronJobService;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  aborted: string[];
  now: () => number;
}

function makeHarness(loopEnabled = true): DoctorHarness {
  const store = makeStore();
  const cronSvc = {
    getById: (id: string) =>
      id === "loop-1" && loopEnabled
        ? ({
            cronJobId: "loop-1",
            name: "l1",
            cronExpr: "*/5 * * * *",
            enabled: true,
            loopConfigPath: "loops/l1",
          } as never)
        : null,
    port: { listCronJobs: () => [] },
  } as unknown as CronJobService;
  const aborted: string[] = [];
  const runs = new Map<string, AgentRun>();
  const agentRunService = {
    async listActiveRunsForConversations() {
      return [];
    },
    async getRun(runId: string) {
      return runs.get(runId) ?? null;
    },
  } as unknown as AgentRunService;
  const agentRunExecution = {
    isLive: () => false,
    isInflight: () => false,
    async abortStaleRun(runId: string) {
      aborted.push(runId);
    },
  } as unknown as AgentRunExecutionService;
  return { store, cronSvc, agentRunService, agentRunExecution, aborted, now: () => 1000 };
}
describe("runLoopDoctor", () => {
  afterEach(() => {
    // no-op: each harness owns its DB
  });

  test("zombie run without a live child is aborted and reported", async () => {
    const h = makeHarness();
    const run: AgentRun = {
      runId: "run-z",
      branchId: "b",
      conversationId: "loop:loop-1:generator",
      agentMemberId: "loop-generator:loop-1",
      modelRef: { backendKind: "oma", modelId: "m" },
      status: "running",
      idempotencyKey: "k",
      terminalResult: null,
      configRevision: 1,
      productTools: null,
      systemPrompt: null,
      skillRoots: null,
      permissionMode: null,
      todoSnapshot: null,
      workspace: null,
      workflowBudgetTokens: null,
      workflow: null,
      createdAt: 0,
      terminalAt: null,
    };
    (
      h.agentRunService as { listActiveRunsForConversations: () => Promise<AgentRun[]> }
    ).listActiveRunsForConversations = async () => [run];

    const report = await runLoopDoctor(
      { ...h, agentRunService: h.agentRunService, agentRunExecution: h.agentRunExecution },
      "loop-1",
    );

    expect(h.aborted).toEqual(["run-z"]);
    expect(report.issues.some((i) => i.kind === "zombie_run")).toBe(true);
    expect(report.fixed).toContain("zombie run run-z");
  });

  test("stale item whose generator run is terminal is escalated to inbox", async () => {
    const h = makeHarness();
    const state = {
      loopId: "loop-1",
      lastRun: null,
      items: {
        "item-1": {
          id: "item-1",
          source: "ci",
          summary: "s",
          step: "fixing" as const,
          attempt: 1,
          priority: 0,
          result: null,
          generatorRunId: "run-dead",
        },
      },
    };
    h.store.save("loop-1", state, {});
    (h.agentRunService as { getRun: () => Promise<AgentRun | null> }).getRun = async () =>
      ({ runId: "run-dead", status: "failed" }) as AgentRun;

    const report = await runLoopDoctor(
      { ...h, agentRunService: h.agentRunService, agentRunExecution: h.agentRunExecution },
      "loop-1",
    );

    const after = h.store.load("loop-1");
    expect(after.items["item-1"]!.step).toBe("inbox");
    expect(report.issues.some((i) => i.kind === "stale_item")).toBe(true);
  });

  test("deferred item whose until passed is undeferred", async () => {
    const h = makeHarness();
    const state = {
      loopId: "loop-1",
      lastRun: null,
      items: {
        "item-1": {
          id: "item-1",
          source: "manual",
          summary: "s",
          step: "triaged" as const,
          attempt: 1,
          priority: 0,
          result: null,
          defer: { reason: "waiting", until: 500 },
        },
      },
    };
    h.store.save("loop-1", state, {});

    const report = await runLoopDoctor(
      { ...h, agentRunService: h.agentRunService, agentRunExecution: h.agentRunExecution },
      "loop-1",
    );

    const after = h.store.load("loop-1");
    expect(after.items["item-1"]!.defer).toBeUndefined();
    expect(report.issues.some((i) => i.kind === "deferred_due")).toBe(true);
  });

  test("unknown loop id yields an empty report", async () => {
    const h = makeHarness();
    const report = await runLoopDoctor(
      { ...h, agentRunService: h.agentRunService, agentRunExecution: h.agentRunExecution },
      "loop-missing",
    );
    expect(report.issues).toEqual([]);
    expect(report.fixed).toEqual([]);
  });
});
