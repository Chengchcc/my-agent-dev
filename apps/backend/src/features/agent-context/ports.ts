import type { Message } from "@chengchenccc/message";
import type { AgentContextEntry, AgentContextTree, ContextBranch } from "./domain.js";

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

  getTreeById(treeId: string): Promise<AgentContextTree | null>;
  getOrCreateDefaultBranch(treeId: string, backendKind: string): Promise<ContextBranch>;

  getBranch(branchId: string): Promise<ContextBranch | null>;

  listEntriesToLeaf(branchId: string): Promise<AgentContextEntry[]>;

  appendEntry(input: AppendEntryInput): Promise<BranchMutationResult>;

  forkBranch(input: ForkBranchInput): Promise<{ branch: ContextBranch }>;

  /** Atomically repin the tree's default branch to `branchId` and set its
   *  backendKind (D2): demotes the previous default, updates the target's
   *  kind, promotes it. Used when an agent's backend kind changes — the
   *  forked branch (or the empty default) becomes the new default. */
  setDefaultBranchKind(
    treeId: string,
    branchId: string,
    backendKind: string,
  ): Promise<ContextBranch>;

  /** Record the branch's CLI session reference (ADR 0019) after a
   *  CLI-backed run settles. No revision bump — informational state. */
  updateBranchCliSessionRef(branchId: string, cliSessionRef: string): Promise<ContextBranch | null>;

  moveBranchLeaf(
    branchId: string,
    expectedRevision: number,
    newLeafEntryId: string,
  ): Promise<ContextBranch>;
}

/** ID generator port; implementations use ulid. */
export interface IdGenerator {
  ulid(): string;
}

/** Narrow port for resolving Ledger Message refs by conversationId + ledgerSeq. */
export interface LedgerMessageResolver {
  resolveMessage(conversationId: string, ledgerSeq: number): Promise<Message | null>;
}
