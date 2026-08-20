import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AgentRun } from "../agent-run/domain.js";
import type { LoopDoctorDeps } from "./loop-doctor.js";
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
  deps: LoopDoctorDeps;
  aborted: string[];
  activeRuns: AgentRun[];
  runById: Map<string, AgentRun | null>;
}

function makeHarness(): DoctorHarness {
  const store = makeStore();
  const aborted: string[] = [];
  const activeRuns: AgentRun[] = [];
  const runById = new Map<string, AgentRun | null>();
  const deps: LoopDoctorDeps = {
    cronSvc: {
      getById: (id: string) =>
        id === "loop-1"
          ? ({
              cronJobId: "loop-1",
              name: "l1",
              cronExpr: "*/5 * * * *",
              enabled: true,
              loopConfigPath: "loops/l1",
            } as never)
          : null,
    },
    store,
    agentRunService: {
      async listActiveRunsForConversations() {
        return activeRuns;
      },
      async getRun(runId: string) {
        return runById.get(runId) ?? null;
      },
    },
    agentRunExecution: {
      isLive: () => false,
      isInflight: () => false,
      async abortStaleRun(runId: string) {
        aborted.push(runId);
      },
    },
    now: () => 1000,
  };
  return { store, deps, aborted, activeRuns, runById };
}

const makeRun = (runId: string): AgentRun => ({
  runId,
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
});

describe("runLoopDoctor", () => {
  test("zombie run without a live child is aborted and reported", async () => {
    const h = makeHarness();
    h.activeRuns.push(makeRun("run-z"));

    const report = await runLoopDoctor(h.deps, "loop-1");

    expect(h.aborted).toEqual(["run-z"]);
    expect(report.issues.some((i) => i.kind === "zombie_run")).toBe(true);
    expect(report.fixed).toContain("zombie run run-z");
  });

  test("stale item whose generator run is terminal is escalated to inbox", async () => {
    const h = makeHarness();
    h.store.save(
      "loop-1",
      {
        loopId: "loop-1",
        lastRun: null,
        items: {
          "item-1": {
            id: "item-1",
            source: "ci",
            summary: "s",
            step: "fixing",
            attempt: 1,
            priority: 0,
            result: null,
            generatorRunId: "run-dead",
          },
        },
      },
      {},
    );
    h.runById.set("run-dead", { ...makeRun("run-dead"), status: "failed" });

    const report = await runLoopDoctor(h.deps, "loop-1");

    const after = h.store.load("loop-1");
    expect(after.items["item-1"]!.step).toBe("inbox");
    expect(report.issues.some((i) => i.kind === "stale_item")).toBe(true);
  });

  test("deferred item whose until passed is undeferred", async () => {
    const h = makeHarness();
    h.store.save(
      "loop-1",
      {
        loopId: "loop-1",
        lastRun: null,
        items: {
          "item-1": {
            id: "item-1",
            source: "manual",
            summary: "s",
            step: "triaged",
            attempt: 1,
            priority: 0,
            result: null,
            defer: { reason: "waiting", until: 500 },
          },
        },
      },
      {},
    );

    const report = await runLoopDoctor(h.deps, "loop-1");

    const after = h.store.load("loop-1");
    expect(after.items["item-1"]!.defer).toBeUndefined();
    expect(report.issues.some((i) => i.kind === "deferred_due")).toBe(true);
  });

  test("unknown loop id yields an empty report", async () => {
    const h = makeHarness();
    const report = await runLoopDoctor(h.deps, "loop-missing");
    expect(report.issues).toEqual([]);
    expect(report.fixed).toEqual([]);
  });
});
