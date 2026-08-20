import type { BackendModelRef } from "@chengchenccc/agent-backend";
import type { BackendConfig } from "../../config.js";
import type { AgentRunExecutionService } from "../agent-run/execution.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort } from "../conversation/ports.js";
import type { LoopStateStore } from "../loop/loop-state-store.js";
import { loopStep } from "../loop/loop-step.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobService } from "./service.js";

/** Narrow interface for cron scheduling, injectable for testing. */
export interface Scheduler {
  schedule(cronExpr: string, fn: () => void): { stop(): void };
}

type CronHandle = ReturnType<Scheduler["schedule"]>;

export const bunScheduler: Scheduler = {
  schedule: (expr, fn) => {
    const handle = Bun.cron(expr, fn);
    return { stop: () => handle.stop() };
  },
};

/** Deterministic headless identities for a cron job's Agent Run scope. */
export function cronConversationId(cronJobId: string): string {
  return `cron:${cronJobId}`;
}
export function cronAgentMemberId(agentId: string): string {
  return `cron-agent:${agentId}`;
}

export function createCronScheduler(deps: {
  cronSvc: CronJobService;
  config: BackendConfig;
  convPort: ConversationPort;
  /** Resolve LOOP.md agent ids to workspace paths (ADR 0023 P2). */
  agentWorkspaceOf: (agentId: string) => Promise<string | null>;
  /** Shared per-worktree lock registry (A4). */
  withWorkspaceLock: <T>(root: string, fn: () => Promise<T>) => Promise<T>;
  /** Per-loop state lock (Bug 1): serializes ticks against manual run/review. */
  withLoopLock?: <T>(loopId: string, fn: () => Promise<T>) => Promise<T>;
  agentRunService: AgentRunService;
  agentRunExecution: AgentRunExecutionService;
  resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;
  now?: () => number;
  scheduler?: Scheduler;
  /** Retry backoff between attempts; default exponential capped at 30s. */
  backoffMs?: (attempt: number) => number;
  projectPort?: ProjectPort;
  store: LoopStateStore;
}) {
  const sched = deps.scheduler ?? bunScheduler;
  const handles = new Map<string, CronHandle>();
  /** Single-flight lock per job. Held until the whole fire chain (the run
   *  + any retries) settles; a natural trigger that arrives meanwhile is
   *  skipped, preserving the no-overlap guarantee. */
  const inFlight = new Set<string>();
  /** The fire-chain promises themselves, so dispose() can drain them
   *  before the DB closes (a settling run may still finalize rows). */
  const inflightPromises = new Set<Promise<void>>();

  /** Idempotently ensure the deterministic Conversation + Agent Member
   *  (branch is lazily created by enqueueAndAcquire). */
  async function ensureCronScope(
    conversationId: string,
    agentMemberId: string,
    agentId: string,
  ): Promise<void> {
    if (!deps.convPort.getConversation(conversationId)) {
      try {
        deps.convPort.createConversation({
          conversationId,
          triggerMode: "mention",
          origin: "cron",
          createdAt: Date.now(),
        });
      } catch {
        /* concurrent create - ignore */
      }
    }
    const members = deps.convPort.getMembers(conversationId);
    if (!members.some((m) => m.memberId === agentMemberId)) {
      deps.convPort.addMember({
        memberId: agentMemberId,
        conversationId,
        kind: "agent",
        agentId,
        joinedAt: Date.now(),
      });
    }
  }

  /** One Agent Run for one fire attempt. Returns true when the run ended
   *  via the watchdog (a deterministic timeout must not burn retries). */
  async function runCronOnce(
    job: CronJobRow,
    conversationId: string,
    agentMemberId: string,
    fireKey: string,
    retry: number,
  ): Promise<boolean> {
    const defaultModel = await deps.resolveDefaultModel(job.agentId);
    const { acquired, run } = await deps.agentRunService.enqueueAndAcquire({
      conversationId,
      agentMemberId,
      backendKind: defaultModel.backendKind,
      mode: "normal",
      message: { role: "user", text: job.prompt ?? "", conversationId },
      defaultModel,
      configRevision: 1,
      idempotencyKey: `${fireKey}:${agentMemberId}:${retry}`,
    });
    if (!acquired || !run) return true; // queued: input is persisted; nothing to re-fire

    let wdHit = false;
    const timer =
      job.timeoutMs > 0
        ? setTimeout(() => {
            wdHit = true;
            void deps.agentRunExecution.stop(run.runId).catch(() => {});
          }, job.timeoutMs)
        : null;
    try {
      await deps.agentRunExecution.dispatch(run.runId);
      const final = await deps.agentRunService.getRun(run.runId);
      // Only a plain `failed` outcome re-fires. completed and commit_failed
      // are terminal-no-retry (commit_failed is repaired by
      // retryTerminalCommit/recover), aborted/timeout are watchdog
      // outcomes that must not burn retries.
      return wdHit || final?.status !== "failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function fire(job: CronJobRow): Promise<void> {
    if (job.loopConfigPath) {
      return fireLoop(job);
    }

    const conversationId = cronConversationId(job.cronJobId);
    const agentMemberId = cronAgentMemberId(job.agentId);
    await ensureCronScope(conversationId, agentMemberId, job.agentId);
    const fireKey = `${job.cronJobId}:${deps.now?.() ?? Date.now()}`;
    const maxRetries = job.maxRetries ?? 0;
    for (let retries = 0; ; retries++) {
      const timedOut = await runCronOnce(job, conversationId, agentMemberId, fireKey, retries);
      if (timedOut || retries >= maxRetries) break;
      const fresh = deps.cronSvc.port.getCronJob(job.cronJobId);
      if (!fresh || (fresh.maxRetries ?? 0) <= 0) break;
      const backoff = deps.backoffMs?.(retries) ?? Math.min(1000 * 2 ** retries, 30_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // Loop jobs execute the Loop step (Generator/Evaluator Agent Runs inside).
  async function fireLoop(job: CronJobRow): Promise<void> {
    const loopStepParams = {
      loopConfigPath: resolveLoopPaths(job, deps.config.dataDir).loopConfigPath,
      projectPort: deps.projectPort,
      dataDir: deps.config.dataDir,
      agentWorkspaceOf: deps.agentWorkspaceOf,
      store: deps.store,
      loopId: job.cronJobId,
      convPort: deps.convPort,
      agentRunService: deps.agentRunService,
      agentRunExecution: deps.agentRunExecution,
      // LOOP.md stores the full canonical model ID; pass it through. Loop
      // runs are oma-scoped (no agent row carries the kind).
      resolveModel: async (modelId: string): Promise<BackendModelRef> => ({
        backendKind: "oma",
        modelId,
      }),
      withWorkspaceLock: deps.withWorkspaceLock,
      ...(deps.withLoopLock ? { withLoopLock: deps.withLoopLock } : {}),
    };
    let attempt = 0;
    let currentJob = job;
    for (;;) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const stepParams = { ...loopStepParams, signal: controller.signal };
        if (currentJob.timeoutMs > 0) {
          // Timeout cancels the loop's live run (not just rejects the
          // promise): abort → loopStep stops the generator child → branch
          // releases → the next tick starts clean. withTimeout stays as a
          // final guard for stalls abort cannot reach.
          timer = setTimeout(() => controller.abort(), currentJob.timeoutMs);
          await withTimeout(loopStep(stepParams), currentJob.timeoutMs);
        } else {
          await loopStep(stepParams);
        }
        return;
      } catch (err) {
        attempt++;
        const maxRetries = currentJob.maxRetries ?? 0;
        if (attempt > maxRetries) throw err;
        const fresh = deps.cronSvc.port.getCronJob(job.cronJobId);
        if (!fresh) throw err;
        currentJob = fresh;
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30_000)));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  return {
    start() {
      for (const job of deps.cronSvc.port.listEnabledCronJobs()) {
        // Isolate per-job registration: one bad cron expression must not abort
        // the whole startup loop and leave every later job unscheduled.
        try {
          this.register(job);
        } catch (err) {
          console.error(`[cron] register failed for ${job.cronJobId}:`, err);
        }
      }
    },

    register(job: CronJobRow) {
      this.unregister(job.cronJobId);
      if (!job.enabled) return;
      // Manual loop: no schedule
      if (!job.cronExpr) return;
      handles.set(
        job.cronJobId,
        sched.schedule(job.cronExpr, () => {
          if (inFlight.has(job.cronJobId)) return;
          inFlight.add(job.cronJobId);
          const p = fire(job)
            .catch((err) => console.error(`[cron] fire failed for ${job.cronJobId}:`, err))
            .finally(() => {
              inFlight.delete(job.cronJobId);
              inflightPromises.delete(p);
            });
          inflightPromises.add(p);
        }),
      );
    },

    unregister(cronJobId: string) {
      const h = handles.get(cronJobId);
      if (h) {
        h.stop();
        handles.delete(cronJobId);
      }
      // Drop the single-flight lock so a re-registered job can fire immediately.
      inFlight.delete(cronJobId);
    },

    async dispose() {
      for (const h of handles.values()) h.stop();
      handles.clear();
      inFlight.clear();
      await Promise.allSettled(inflightPromises);
      inflightPromises.clear();
    },
  };
}

export type CronScheduler = ReturnType<typeof createCronScheduler>;
