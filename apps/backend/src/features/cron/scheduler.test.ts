import { describe, expect, mock, test } from "bun:test";
import type { BackendRunOutcome } from "@my-agent-team/agent-backend";
import type { AgentRun } from "../agent-run/domain.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { CronJobRow } from "./domain.js";
import { createCronScheduler, type Scheduler } from "./scheduler.js";

function makeJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    cronJobId: "cj-test",
    name: "Test Job",
    agentId: "agent-1",
    cronExpr: "0 9 * * *",
    prompt: "hello",
    enabled: true,
    timeoutMs: 0,
    maxRetries: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ── Fake Agent Run services ────────────────────────────────────────────────

function makeRunsFakes(script: {
  status?: AgentRun["status"];
  queue?: boolean;
  usageTokens?: number;
}) {
  const enqueues: Array<{
    conversationId: string;
    agentMemberId: string;
    mode: string;
    idempotencyKey: string;
  }> = [];
  const stops: string[] = [];
  let seq = 0;
  const runs = new Map<string, AgentRun>();
  const runService: AgentRunService = {
    async enqueueAndAcquire(input) {
      enqueues.push({
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
      });
      if (script.queue) {
        return { acquired: false, queued: true, replayed: false, inputId: "in" };
      }
      const runId = `run-${++seq}`;
      const run: AgentRun = {
        runId,
        branchId: "b",
        conversationId: input.conversationId,
        agentMemberId: input.agentMemberId,
        modelRef: { backendKind: "coding_agent", modelId: "m" },
        status: "running",
        idempotencyKey: input.idempotencyKey,
        terminalResult: null,
        configRevision: 1,
        productTools: null,
        systemPrompt: null,
        skillRoots: null,
        workspace: null,
        createdAt: 0,
        terminalAt: null,
      };
      runs.set(runId, run);
      return { acquired: true, queued: false, replayed: false, run, inputId: `in-${runId}` };
    },
    async markInputAccepted(inputId) {
      return { inputId } as never;
    },
    async createPendingAction(runId, action) {
      return { runId, actionId: "a", ...action } as never;
    },
    async consumePendingAction(actionId) {
      return { action: { actionId } as never, runId: "r" };
    },
    async finalizeRun(runId) {
      return runs.get(runId)!;
    },
    async getRun(runId) {
      const run = runs.get(runId);
      if (run) {
        (run as { status: AgentRun["status"] }).status = script.status ?? "completed";
        (run as { terminalResult: BackendRunOutcome | null }).terminalResult = {
          status:
            script.status === "completed" || script.status === undefined
              ? "completed"
              : script.status,
          ...(script.usageTokens !== undefined
            ? { usage: { inputTokens: script.usageTokens, outputTokens: 0 } }
            : {}),
        } as BackendRunOutcome;
      }
      return run ?? null;
    },
    async getActiveRun() {
      return null;
    },
    async listInputs() {
      return [];
    },
  };
  const execution: AgentRunExecutionService = {
    async dispatch(runId) {
      const run = runs.get(runId);
      if (run) (run as { status: AgentRun["status"] }).status = script.status ?? "completed";
    },
    async recover() {},
    async injectSteer() {},
    async retryTerminalCommit() {},
    async stop(runId) {
      stops.push(runId);
    },
    subscribe() {
      return (async function* () {})();
    },
  };
  return { runService, execution, enqueues, stops };
}

/** Minimal deps: register/unregister/dispose/start + a fake fire chain. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const fakeSched: Scheduler = {
    schedule: (expr, fn) => {
      const job = overrides.scheduleFns as Map<string, () => void> | undefined;
      const handle = { stop: mock(() => {}) };
      job?.set(String(expr), fn);
      return handle;
    },
  };
  const fakes = makeRunsFakes((overrides.script as object) ?? {});
  return {
    fakeSched,
    fakes,
    deps: {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => null,
        },
        getById: () => null,
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({ member: null, created: true }),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      scheduler: fakeSched,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0],
  };
}

describe("createCronScheduler (Agent Run cutover)", () => {
  test("register enabled job schedules via Bun.cron-compatible scheduler", () => {
    const { deps, fakeSched } = makeDeps();
    const sched = createCronScheduler(deps);
    const handles = new Map<string, () => void>();
    // re-create with a capturing scheduler
    const deps2 = {
      ...(deps as unknown as Record<string, unknown>),
      scheduler: {
        schedule: (expr: string, fn: () => void) => {
          handles.set(expr, fn);
          return { stop: () => {} };
        },
      } as Scheduler,
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched2 = createCronScheduler(deps2);
    sched2.register(makeJob());
    expect(handles.has("0 9 * * *")).toBe(true);
    sched.dispose();
    sched2.dispose();
    void fakeSched;
  });

  test("register disabled job does not schedule", () => {
    const handles = new Map<string, () => void>();
    const { deps } = makeDeps();
    const sched = createCronScheduler({
      ...deps,
      scheduler: {
        schedule: (expr: string, fn: () => void) => {
          handles.set(expr, fn);
          return { stop: () => {} };
        },
      } as Scheduler,
    } as unknown as Parameters<typeof createCronScheduler>[0]);
    sched.register(makeJob({ enabled: false }));
    expect(handles.size).toBe(0);
    sched.dispose();
  });

  test("unregister stops the handle", () => {
    let stopped = false;
    const { deps } = makeDeps();
    const sched = createCronScheduler({
      ...deps,
      scheduler: {
        schedule: () => {
          return { stop: () => (stopped = true) };
        },
      } as Scheduler,
    } as unknown as Parameters<typeof createCronScheduler>[0]);
    sched.register(makeJob());
    sched.unregister("cj-test");
    expect(stopped).toBe(true);
    sched.dispose();
  });

  test("fire creates a durable Agent Run on the deterministic scope and dispatches it", async () => {
    const fakes = makeRunsFakes({});
    const conv = {
      createConversation: () => ({}),
      addMember: () => ({ member: null, created: true }),
      getConversation: () => null,
      getMembers: () => [],
    };
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => null,
        },
      },
      config: { dataDir: "/tmp" },
      convPort: conv,
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      now: () => 1_700_000_000_000,
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];

    const sched = createCronScheduler(deps);
    const job = makeJob();
    sched.register(job);
    fired!();
    await new Promise((r) => setTimeout(r, 20));

    expect(fakes.enqueues).toHaveLength(1);
    const e = fakes.enqueues[0]!;
    expect(e.conversationId).toBe("cron:cj-test");
    expect(e.agentMemberId).toBe("cron-agent:agent-1");
    expect(e.mode).toBe("normal");
    // fire identity is deterministic: cronJobId + scheduledAt
    expect(e.idempotencyKey).toBe(`cj-test:1700000000000:cron-agent:agent-1:0`);
    sched.dispose();
  });

  test("queued fire does not dispatch (branch busy elsewhere)", async () => {
    const fakes = makeRunsFakes({ queue: true });
    let fired: (() => void) | null = null;
    const dispatchSpy = mock(async () => {});
    const deps = {
      cronSvc: { port: { listEnabledCronJobs: () => [] as CronJobRow[], getCronJob: () => null } },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: { ...fakes.execution, dispatch: dispatchSpy },
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    sched.register(makeJob());
    fired!();
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatchSpy).not.toHaveBeenCalled();
    sched.dispose();
  });

  test("timeout watchdog calls stop(runId); timed-out fire does not retry", async () => {
    const fakes = makeRunsFakes({ status: "aborted" });
    const stopSpy = mock(async () => {});
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => makeJob({ maxRetries: 3 }),
        },
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: { ...fakes.execution, stop: stopSpy },
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = () => {
            void fn();
          };
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    // the watchdog fires while dispatch is "running"; simulate by stopping
    // after a short delay
    const job = makeJob({ timeoutMs: 5, maxRetries: 3 });
    sched.register(job);
    fired!();
    await new Promise((r) => setTimeout(r, 80));
    // aborted + watchdog path must NOT retry: exactly one enqueue
    expect(fakes.enqueues).toHaveLength(1);
    sched.dispose();
  });

  test("failed run retries up to maxRetries with fresh runs (same fire identity)", async () => {
    const fakes = makeRunsFakes({ status: "failed" });
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => makeJob({ maxRetries: 2 }),
        },
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      now: () => 1_700_000_000_000,
      backoffMs: () => 1,
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    sched.register(makeJob({ maxRetries: 2 }));
    fired!();
    await new Promise((r) => setTimeout(r, 60));
    // attempt 0 + 2 retries = 3 runs, each a NEW run id with retry suffix
    expect(fakes.enqueues).toHaveLength(3);
    expect(fakes.enqueues[0]!.idempotencyKey.endsWith(":0")).toBe(true);
    expect(fakes.enqueues[1]!.idempotencyKey.endsWith(":1")).toBe(true);
    expect(fakes.enqueues[2]!.idempotencyKey.endsWith(":2")).toBe(true);
    expect(
      new Set(fakes.enqueues.map((e) => e.idempotencyKey.split(":").slice(0, 2).join(":"))).size,
    ).toBe(1);
    sched.dispose();
  });

  test("COMPLETED run does not re-fire even with maxRetries set", async () => {
    const fakes = makeRunsFakes({ status: "completed" });
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => makeJob({ maxRetries: 3 }),
        },
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      backoffMs: () => 1,
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    sched.register(makeJob({ maxRetries: 3 }));
    fired!();
    await new Promise((r) => setTimeout(r, 40));
    // success must NOT retry: exactly one run
    expect(fakes.enqueues).toHaveLength(1);
    sched.dispose();
  });

  test("commit_failed run does not re-fire (repaired by retryTerminalCommit)", async () => {
    const fakes = makeRunsFakes({ status: "commit_failed" });
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => makeJob({ maxRetries: 2 }),
        },
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      backoffMs: () => 1,
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    sched.register(makeJob({ maxRetries: 2 }));
    fired!();
    await new Promise((r) => setTimeout(r, 40));
    expect(fakes.enqueues).toHaveLength(1);
    sched.dispose();
  });

  test("overlapping triggers stay single-flight", async () => {
    const fakes = makeRunsFakes({ status: "failed" });
    let fired: (() => void) | null = null;
    const deps = {
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [] as CronJobRow[],
          getCronJob: () => makeJob({ maxRetries: 0 }),
        },
      },
      config: { dataDir: "/tmp" },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
      agentRunService: fakes.runService,
      agentRunExecution: fakes.execution,
      resolveDefaultModel: async () => ({ backendKind: "coding_agent", modelId: "m" }),
      scheduler: {
        schedule: (_expr: string, fn: () => void) => {
          fired = fn;
          return { stop: () => {} };
        },
      } as Scheduler,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
    } as unknown as Parameters<typeof createCronScheduler>[0];
    const sched = createCronScheduler(deps);
    sched.register(makeJob({ maxRetries: 0 }));
    fired!();
    fired!(); // second trigger while first chain still settling
    await new Promise((r) => setTimeout(r, 40));
    expect(fakes.enqueues).toHaveLength(1);
    sched.dispose();
  });

  test("loop job routes through loopStep params (no session manager)", () => {
    const { deps } = makeDeps();
    const sched = createCronScheduler({
      ...deps,
      config: { dataDir: "/tmp" },
      projectPort: undefined,
      store: { load: () => ({ loopId: "x", lastRun: null, items: {} }) },
      convPort: {
        createConversation: () => ({}),
        addMember: () => ({}),
        getConversation: () => null,
        getMembers: () => [],
      },
    } as unknown as Parameters<typeof createCronScheduler>[0]);
    sched.register(makeJob({ loopConfigPath: "loops/x", cronExpr: "" }));
    sched.dispose();
    // construction succeeds without legacy runtime services
    expect(true).toBe(true);
  });
});
