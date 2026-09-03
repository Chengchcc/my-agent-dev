import type { Database } from "bun:sqlite";
import type {
  AgentContextPort,
  IdGenerator,
  LedgerMessageResolver,
} from "../agent-context/ports.js";
import { createActionMethods } from "./adapter-sqlite-actions.js";
import { createEnqueueMethod } from "./adapter-sqlite-enqueue.js";
import { createInputQueueMethods } from "./adapter-sqlite-inputs.js";
import { createRunMethods } from "./adapter-sqlite-runs.js";
import type { AgentRunPort } from "./ports.js";

export interface AgentRunAdapterDeps {
  readonly contextPort: AgentContextPort;
  readonly ledgerResolver: LedgerMessageResolver;
  readonly idGen: IdGenerator;
  /** TEST-ONLY fault injection: called at the end of the commitCompletedRun
   *  transaction (before the run is marked completed). Production callers
   *  never pass it; tests throw here to prove the whole transaction rolls
   *  back with zero partial Product facts. */
  readonly commitTestHook?: () => void;
}

export function sqliteAgentRunAdapter(db: Database, deps: AgentRunAdapterDeps): AgentRunPort {
  return {
    ...createEnqueueMethod(db, deps),
    ...createInputQueueMethods(db),
    ...createActionMethods(db),
    ...createRunMethods(db, deps),
  };
}
