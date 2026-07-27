import { join } from "node:path";
import type { SessionManager } from "@my-agent-team/agent";
import { createAgentSession } from "@my-agent-team/agent";
import type { ModelRegistry, ProviderAuth } from "@my-agent-team/ai";
import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import type { LoopStateStore } from "../loop/loop-state-store.js";
import { loopStep } from "../loop/loop-step.js";
import { resolveLoopPaths } from "../loop/resolve-paths.js";
import type { ProjectPort } from "../project/ports.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import {
  createModel,
  defaultContextManager,
  defaultPlugins,
  defaultTools,
  resolveModel,
} from "../span/agent-helpers.js";
import type { SkillRoots } from "../span/skill-roots.js";
import type { SpanSupervisor } from "../span/supervisor.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobService } from "./service.js";

/** Narrow interface for cron scheduling, injectable for testing. */
export interface Scheduler {
  schedule(cronExpr: string, fn: () => void): { stop(): void };
}

type CronHandle = ReturnType<Scheduler["schedule"]>;

export const bunScheduler: Scheduler = {
  schedule: (expr, fn) => {
    const h = Bun.cron(expr, fn);
    return { stop: () => h.stop() };
  },
};

export function createCronScheduler(deps: {
  cronSvc: CronJobService;
  config: BackendConfig;
  agentSvc: AgentService;
  supervisor: SpanSupervisor;
  opsStore: RuntimeOpsStore;
  idGen: () => string;
  now?: () => number;
  scheduler?: Scheduler;
  sessionManager: SessionManager;
  projectPort?: ProjectPort;
  store: LoopStateStore;
  modelRegistry: ModelRegistry;
}) {
  const sched = deps.scheduler ?? bunScheduler;
  const handles = new Map<string, CronHandle>();
  /** spanId → { timer, cronJobId } so unregister() can clear in-flight watchdogs. */
  const watchdogs = new Map<string, { timer: ReturnType<typeof setTimeout>; cronJobId: string }>();
  /** runIds cancelled by their per-job watchdog — excluded from retry (a job that
   *  always exceeds timeoutMs would otherwise burn every retry on the same timeout). */
  const timedOut = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string, number>();
  /** Single-flight lock per job. Held from a natural Bun.cron trigger until the
   *  whole fire chain (the run + any retries) settles. A natural trigger that
   *  arrives while the previous chain is still in flight is skipped, restoring
   *  the no-overlap guarantee that the decoupled (setTimeout) retry path would
   *  otherwise break. Retries do NOT re-acquire — they continue the held lock. */
  const inFlight = new Set<string>();

  async function fire(job: CronJobRow, _fireKey?: string): Promise<void> {
    if (job.loopConfigPath) {
      return fireLoop(job);
    }

    const spanId = deps.idGen();
    try {
      const { modelProvider, modelName } = await deps.agentSvc.getById(job.agentId);
      const cwd = join(deps.config.dataDir, "agents", job.agentId);
      const session = await createAgentSession({
        model: createModel(
          resolveModel(`${modelProvider}/${modelName}`, deps.modelRegistry),
          deps.modelRegistry,
          {
            apiKey: deps.config.anthropicApiKey,
            baseUrl: deps.config.anthropicBaseUrl,
          } as ProviderAuth,
        ),
        tools: defaultTools(cwd),
        plugins: defaultPlugins(cwd, deps.config),
        contextManager: defaultContextManager(),
        sessionManager: deps.sessionManager,
      });
      void session
        .prompt(job.prompt ?? "", {
          origin: { agentMemberId: job.agentId, originKind: "cron", cronJobId: job.cronJobId },
        })
        .catch((err: unknown) => {
          console.error(`[cron] prompt error:`, err);
        });
    } catch (err) {
      inFlight.delete(job.cronJobId);
      throw err;
    }

    if (job.timeoutMs > 0) {
      const timer = setTimeout(() => {
        timedOut.add(spanId);
        void deps.supervisor.cancel(spanId);
      }, job.timeoutMs);
      watchdogs.set(spanId, { timer, cronJobId: job.cronJobId });
    }
  }

  // M4: Loop-aware fire with inline retry + timeout
  async function fireLoop(job: CronJobRow): Promise<void> {
    let attempt = 0;
    let currentJob = job;

    while (true) {
      try {
        if (currentJob.timeoutMs > 0) {
          await withTimeout(
            loopStep({
              loopConfigPath: resolveLoopPaths(currentJob, deps.config.dataDir).loopConfigPath,
              sessionManager: deps.sessionManager!,
              buildConfig,
              projectPort: deps.projectPort,
              dataDir: deps.config.dataDir,
              store: deps.store,
              loopId: currentJob.cronJobId,
            }),
            currentJob.timeoutMs,
          );
        } else {
          await loopStep({
            loopConfigPath: resolveLoopPaths(currentJob, deps.config.dataDir).loopConfigPath,
            sessionManager: deps.sessionManager!,
            buildConfig,
            projectPort: deps.projectPort,
            dataDir: deps.config.dataDir,
            store: deps.store,
            loopId: currentJob.cronJobId,
          });
        }
        return;
      } catch (err) {
        attempt++;
        const maxRetries = currentJob.maxRetries ?? 0;
        if (attempt > maxRetries) {
          inFlight.delete(job.cronJobId);
          throw err;
        }

        const fresh = deps.cronSvc.port.getCronJob(job.cronJobId);
        if (!fresh) {
          inFlight.delete(job.cronJobId);
          throw err;
        }
        currentJob = fresh;

        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30_000)));
      }
    }
  }

  // buildConfig for loop agent sessions — delegates to agentConfig
  function buildConfig(params: { modelName: string; cwd: string; skillRoots?: SkillRoots }) {
    return {
      model: createModel(resolveModel(params.modelName, deps.modelRegistry), deps.modelRegistry, {
        apiKey: deps.config.anthropicApiKey,
        baseUrl: deps.config.anthropicBaseUrl,
      } as ProviderAuth),
      tools: defaultTools(params.cwd),
      plugins: defaultPlugins(params.cwd, deps.config, params.skillRoots),
      contextManager: defaultContextManager(),
    };
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

  // Retry + watchdog cleanup listener.
  //
  // CRITICAL: supervisor.#runCompletionListeners awaits each listener
  // sequentially in a for-of loop.  Blocking here with await sleep(N)
  // would stall other listeners (ledger terminal write, lock release).
  //
  // Strategy: synchronous checks + cleanup run immediately; if a retry
  // is needed, schedule it via setTimeout so this callback returns
  // without blocking the listener loop.
  deps.supervisor.onRunComplete(async (_sessionId, spanId, status, _kind) => {
    // Clean watchdog timer if present
    const wd = watchdogs.get(spanId);
    if (wd) {
      clearTimeout(wd.timer);
      watchdogs.delete(spanId);
    }
    const wasTimedOut = timedOut.delete(spanId);

    // Only handle cron runs
    const origin = deps.opsStore.getSpanOrigin(spanId);
    if (origin?.originKind !== "cron" || !origin.cronJobId) return;

    const fireKey = origin.idempotencyKey.split(":run:")[0]!;

    // No retry on success — clear any retry bookkeeping for this fire and
    // release the single-flight lock so the next natural trigger can fire.
    if (status === "succeeded") {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    // A run killed by its own per-job watchdog will time out again on retry;
    // don't burn maxRetries on the same deterministic timeout.
    if (wasTimedOut) {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    const job = deps.cronSvc.port.getCronJob(origin.cronJobId);
    if (!job || job.maxRetries <= 0) {
      inFlight.delete(origin.cronJobId);
      return;
    }
    const attempts = retryCounts.get(fireKey) ?? 0;
    if (attempts >= job.maxRetries) {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    retryCounts.set(fireKey, attempts + 1);
    deps.opsStore.appendControlPlaneEvent({
      spanId,
      kind: "retry_requested",
      payload: { fireKey, attempt: attempts + 1 },
    });

    // Non-blocking exponential backoff: setTimeout + async IIFE so the
    // listener returns immediately.  The backoff delay does NOT stall
    // other onRunComplete listeners.
    const backoffMs = Math.min(1000 * 2 ** attempts, 30_000);
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      void (async () => {
        deps.opsStore.appendControlPlaneEvent({
          spanId,
          kind: "retry_started",
          payload: { fireKey, attempt: attempts + 1 },
        });
        await fire(job, fireKey).catch((err) =>
          console.error(`[cron] retry fire failed for ${job.cronJobId}:`, err),
        );
      })();
    }, backoffMs);
    retryTimers.add(timer);
  });

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
          fire(job).catch((err) => console.error(`[cron] fire failed for ${job.cronJobId}:`, err));
        }),
      );
    },

    unregister(cronJobId: string) {
      const h = handles.get(cronJobId);
      if (h) {
        h.stop();
        handles.delete(cronJobId);
      }
      // Clear any in-flight watchdog timers owned by this job.
      for (const [spanId, wd] of watchdogs) {
        if (wd.cronJobId === cronJobId) {
          clearTimeout(wd.timer);
          watchdogs.delete(spanId);
          timedOut.delete(spanId);
        }
      }
      // Drop the single-flight lock so a re-registered job can fire immediately.
      inFlight.delete(cronJobId);
    },

    dispose() {
      for (const h of handles.values()) h.stop();
      handles.clear();
      for (const wd of watchdogs.values()) clearTimeout(wd.timer);
      watchdogs.clear();
      timedOut.clear();
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      retryCounts.clear();
      inFlight.clear();
    },
  };
}

export type CronScheduler = ReturnType<typeof createCronScheduler>;
