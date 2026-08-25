import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobPort } from "./ports.js";

export class CronJobNotFoundError extends NotFoundError {
  constructor(id: string) {
    super("CronJob", id);
  }
}

export class CronJobValidationError extends ValidationError {}

/** Semantic validation of a 5-field cron expression.
 *  The HTTP/zod layer only checks field count; an expression like
 *  "99 99 99 99 99" passes that but makes Bun.cron throw at register time,
 *  which would 500 the request (after the row is already persisted) and,
 *  worse, abort scheduler.start()'s registration loop on reboot. We reject
 *  it up front by asking Bun to parse it. An empty expression is legal: it
 *  means a manual schedule (Loops without cron run on demand). */
function assertValidCronExpr(expr: string): void {
  if (!expr) return;
  const parse = (Bun as unknown as { cron?: { parse?: (e: string) => unknown } }).cron?.parse;
  if (typeof parse !== "function") return; // older Bun: fall back to register-time guard
  try {
    parse(expr);
  } catch {
    throw new CronJobValidationError(`invalid cron expression: ${expr}`);
  }
}

export interface CronJobServiceDeps {
  port: CronJobPort;
  idGen: () => string;
  agentExists: (id: string) => Promise<boolean>;
  now?: () => number;
  convPort?: {
    createConversation: (input: {
      conversationId: string;
      agentId?: string;
      title?: string;
      origin?: string;
    }) => void;
  };
}

export function createCronJobService(deps: CronJobServiceDeps) {
  const { port, idGen, agentExists } = deps;
  const now = deps.now ?? Date.now;

  function require(id: string): CronJobRow {
    const j = port.getCronJob(id);
    if (!j) throw new CronJobNotFoundError(id);
    return j;
  }

  return {
    port,

    async createCronJob(input: {
      name: string;
      agentId: string;
      cronExpr: string;
      prompt?: string;
      timeoutMs?: number;
      maxRetries?: number;
      enabled?: boolean;
      loopConfigPath?: string;
    }): Promise<CronJobRow> {
      if (!(await agentExists(input.agentId))) {
        throw new CronJobValidationError(`agent not found: ${input.agentId}`);
      }
      assertValidCronExpr(input.cronExpr);
      const cronJobId = idGen();
      const ts = now();
      port.createCronJob({
        cronJobId,
        name: input.name,
        agentId: input.agentId,
        cronExpr: input.cronExpr,
        prompt: input.prompt ?? "",
        enabled: input.enabled ?? false,
        timeoutMs: input.timeoutMs ?? 0,
        maxRetries: input.maxRetries ?? 0,
        loopConfigPath: input.loopConfigPath,
        createdAt: ts,
        updatedAt: ts,
      });
      // best-effort self-owned conversation (conversationId = cronJobId)
      try {
        deps.convPort?.createConversation({
          conversationId: cronJobId,
          agentId: input.agentId,
          title: input.name,
          origin: "cron",
        });
      } catch (e) {
        console.error(`[cron] conv bootstrap failed for ${cronJobId}: ${String(e)}`);
      }
      return require(cronJobId);
    },

    getById(id: string): CronJobRow {
      return require(id);
    },

    list(): CronJobRow[] {
      return port.listCronJobs();
    },

    exists(id: string): boolean {
      return port.getCronJob(id) !== null;
    },

    async update(
      id: string,
      patch: {
        name?: string;
        agentId?: string;
        cronExpr?: string;
        prompt?: string;
        timeoutMs?: number;
        maxRetries?: number;
        enabled?: boolean;
      },
    ): Promise<CronJobRow> {
      if (patch.agentId !== undefined && !(await agentExists(patch.agentId))) {
        throw new CronJobValidationError(`agent not found: ${patch.agentId}`);
      }
      if (patch.cronExpr !== undefined) assertValidCronExpr(patch.cronExpr);
      const result = port.updateCronJob(id, { ...patch, updatedAt: now() });
      if (!result) throw new CronJobNotFoundError(id);
      return result;
    },

    setEnabled(id: string, enabled: boolean): CronJobRow {
      const result = port.updateCronJob(id, { enabled, updatedAt: now() });
      if (!result) throw new CronJobNotFoundError(id);
      return result;
    },

    remove(id: string): void {
      if (!port.deleteCronJob(id)) throw new CronJobNotFoundError(id);
    },
  };
}

export type CronJobService = ReturnType<typeof createCronJobService>;
