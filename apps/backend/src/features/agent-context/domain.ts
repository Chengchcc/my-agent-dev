import type { BackendModelRef } from "@my-agent-team/agent-backend";
import type { Message } from "@my-agent-team/message";

// ─── Errors ──────────────────────────────────────────────────────

export class AgentContextNotFoundError extends Error {
  constructor(
    readonly conversationId: string,
    readonly agentMemberId: string,
  ) {
    super(`Agent Context not found for (${conversationId}, ${agentMemberId})`);
    this.name = "AgentContextNotFoundError";
  }
}

export class ContextBranchNotFoundError extends Error {
  constructor(readonly branchId: string) {
    super(`Context Branch not found: ${branchId}`);
    this.name = "ContextBranchNotFoundError";
  }
}

export class ContextRevisionConflictError extends Error {
  constructor(
    readonly branchId: string,
    readonly expectedRevision: number,
  ) {
    super(`Context revision conflict on branch ${branchId}: expected ${expectedRevision}`);
    this.name = "ContextRevisionConflictError";
  }
}

export class InvalidContextEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContextEntryError";
  }
}

// ─── Tree ────────────────────────────────────────────────────────

export interface AgentContextTree {
  readonly treeId: string;
  readonly conversationId: string;
  readonly agentMemberId: string;
  readonly createdAt: number;
}

// ─── Entry types ─────────────────────────────────────────────────

export type AgentContextEntryType =
  | "ledger_message"
  | "private_message"
  | "product_tool_exchange"
  | "summary"
  | "model_change";

export interface LedgerMessageEntry {
  readonly type: "ledger_message";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly ledgerSeq: number;
  readonly createdAt: number;
}

export interface PrivateMessageEntry {
  readonly type: "private_message";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly message: Message;
  readonly createdAt: number;
}

export interface ProductToolExchangeEntry {
  readonly type: "product_tool_exchange";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly toolName: string;
  readonly callResult: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
}

export interface ProductSummaryEntry {
  readonly type: "summary";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly summary: string;
  readonly coversThroughEntryId: string;
  readonly createdAt: number;
}

export interface ModelChangeEntry {
  readonly type: "model_change";
  readonly entryId: string;
  readonly parentId: string | null;
  readonly model: BackendModelRef;
  readonly createdAt: number;
}

export type AgentContextEntry =
  | LedgerMessageEntry
  | PrivateMessageEntry
  | ProductToolExchangeEntry
  | ProductSummaryEntry
  | ModelChangeEntry;

// ─── Branch ──────────────────────────────────────────────────────

export interface ContextBranch {
  readonly branchId: string;
  readonly treeId: string;
  readonly leafEntryId: string | null;
  readonly ledgerCursor: number;
  readonly backendKind: string;
  /** CLI session reference (ADR 0002): claude session_id or pi/omp
   *  session file path — the CLI-side runtime truth for context
   *  continuation. Null until the first CLI-backed run. */
  readonly cliSessionRef: string | null;
  readonly isDefault: boolean;
  readonly revision: number;
  readonly createdAt: number;
}

// ─── Validation helpers ──────────────────────────────────────────

/** Validate that only ledger_message has ledgerSeq, summary has
 *  coversThroughEntryId, and model_change matches the branch backend kind. */
export function validateEntry(entry: AgentContextEntry, branchBackendKind: string): void {
  if (entry.type === "ledger_message") {
    if (entry.ledgerSeq === undefined || entry.ledgerSeq === null) {
      throw new InvalidContextEntryError("ledger_message requires ledgerSeq");
    }
  } else {
    // Non-ledger entries must not carry ledgerSeq
    if ("ledgerSeq" in entry) {
      throw new InvalidContextEntryError(`${entry.type} must not have ledgerSeq`);
    }
  }

  if (entry.type === "summary" && !entry.coversThroughEntryId) {
    throw new InvalidContextEntryError("summary requires coversThroughEntryId");
  }

  if (entry.type === "model_change") {
    if (entry.model.backendKind !== branchBackendKind) {
      throw new InvalidContextEntryError(
        `model_change backendKind "${entry.model.backendKind}" does not match branch backendKind "${branchBackendKind}"`,
      );
    }
  }
}
