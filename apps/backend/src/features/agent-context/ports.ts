import type { Message } from "@my-agent-team/message";
import type {
  AgentContextEntry,
  AgentContextTree,
  BackendSessionBinding,
  ContextBranch,
} from "./domain.js";

/** Append input for a new entry on a branch leaf. */
export interface AppendEntryInput {
  readonly branchId: string;
  readonly expectedRevision: number;
  readonly type: AgentContextEntry["type"];
  readonly parentId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly ledgerSeq?: number;
}

/** Fork input: create a new branch from a given entry. */
export interface ForkBranchInput {
  readonly sourceBranchId: string;
  readonly expectedRevision: number;
  readonly fromEntryId: string;
  readonly backendKind?: string;
}

/** Result of a branch-mutating operation: the updated branch. */
export interface BranchMutationResult {
  readonly branch: ContextBranch;
  readonly entryId: string;
}

/** Storage port for Agent Context persistence. Transaction-scoped operations
 *  (acquire) belong to the Agent Run adapter, not here. */
export interface AgentContextPort {
  getOrCreateTree(conversationId: string, agentMemberId: string): Promise<AgentContextTree>;

  getTree(conversationId: string, agentMemberId: string): Promise<AgentContextTree | null>;

  getOrCreateDefaultBranch(treeId: string, backendKind: string): Promise<ContextBranch>;

  getBranch(branchId: string): Promise<ContextBranch | null>;

  listEntriesToLeaf(branchId: string): Promise<AgentContextEntry[]>;

  appendEntry(input: AppendEntryInput): Promise<BranchMutationResult>;

  forkBranch(input: ForkBranchInput): Promise<{ branch: ContextBranch }>;

  moveBranchLeaf(
    branchId: string,
    expectedRevision: number,
    newLeafEntryId: string,
  ): Promise<ContextBranch>;

  markBindingStale(branchId: string): Promise<void>;

  upsertBinding(binding: BackendSessionBinding): Promise<BackendSessionBinding>;

  getBinding(branchId: string): Promise<BackendSessionBinding | null>;
}

/** ID generator port; implementations use ulid. */
export interface IdGenerator {
  ulid(): string;
}

/** Narrow port for resolving Ledger Message refs by conversationId + ledgerSeq. */
export interface LedgerMessageResolver {
  resolveMessage(conversationId: string, ledgerSeq: number): Promise<Message | null>;
}
