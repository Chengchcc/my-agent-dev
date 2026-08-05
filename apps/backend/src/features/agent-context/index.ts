export { sqliteAgentContextAdapter } from "./adapter-sqlite.js";
export type {
  AgentContextEntry,
  AgentContextEntryType,
  AgentContextTree,
  ContextBranch,
  LedgerMessageEntry,
  ModelChangeEntry,
  PrivateMessageEntry,
  ProductSummaryEntry,
  ProductToolExchangeEntry,
} from "./domain.js";
export {
  AgentContextNotFoundError,
  ContextBranchNotFoundError,
  ContextRevisionConflictError,
  InvalidContextEntryError,
  validateEntry,
} from "./domain.js";
export type {
  AgentContextPort,
  AppendEntryInput,
  BranchMutationResult,
  ForkBranchInput,
  IdGenerator,
  LedgerMessageResolver,
} from "./ports.js";
export type { ProjectionDeps, ProjectionInput } from "./projection.js";
export { projectAgentContext } from "./projection.js";
export type { AgentContextService, AgentContextServiceDeps } from "./service.js";
export { createAgentContextService } from "./service.js";
