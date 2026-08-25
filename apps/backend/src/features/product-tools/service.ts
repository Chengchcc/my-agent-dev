import type { Message } from "@chengchenccc/message";
import type { AgentContextPort, IdGenerator } from "../agent-context/ports.js";
import { type AgentRun, isActiveStatus } from "../agent-run/domain.js";
import type { AgentRunPort } from "../agent-run/ports.js";
import type { ConversationPort, LedgerEntry } from "../conversation/ports.js";

// ─── Product Tool Call identity (mirrors the Oma wire identity) ─

export interface ProductToolCallIdentity {
  readonly runId: string;
  readonly conversationId: string;
  readonly agentMemberId: string;
  readonly branchId: string;
}

export interface ProductToolCallInput {
  readonly identity: ProductToolCallIdentity;
  /** The REAL model tool-use id (PendingToolCall.id), never an order counter. */
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface ProductToolCallResult {
  readonly content: string;
  readonly isError?: boolean;
}

/** Durable idempotency + audit for semantic MUTATION calls. Read-only tools
 *  never touch it. Same (runId, callId) + same tool/input -> stored result;
 *  different tool/input -> conflict. */
export interface ProductToolCallPort {
  getCall(
    runId: string,
    callId: string,
  ): Promise<{
    toolName: string;
    inputHash: string;
    result: string | null;
    error: string | null;
  } | null>;
  recordCall(input: {
    runId: string;
    callId: string;
    toolName: string;
    inputHash: string;
    result: string;
  }): Promise<void>;
  /** Atomically retain a ledger message into the branch AND record the call
   *  terminal result in ONE transaction: the Context append and the durable
   *  call record can never diverge (no half-retained crash state, no
   *  duplicate ref under concurrent same-call replays). */
  retainHistoryMessageOnce(input: {
    runId: string;
    callId: string;
    toolName: string;
    inputHash: string;
    branchId: string;
    ledgerSeq: number;
    result: string;
  }): Promise<{ outcome: "stored" | "retained" | "conflict"; result?: string }>;
}

/** A Product Tool call was rejected (identity/scope/manifest violation). The
 *  MCP layer normalizes this into an isError tool result. */
export class ProductToolRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductToolRejectedError";
  }
}

export interface ProductToolsServiceDeps {
  readonly runPort: AgentRunPort;
  readonly contextPort: AgentContextPort;
  readonly conversationPort: ConversationPort;
  readonly callPort: ProductToolCallPort;
  readonly idGen: IdGenerator;
}

export interface ProductToolsService {
  call(input: ProductToolCallInput): Promise<ProductToolCallResult>;
}

/** Canonical History operations. The conversation scope is ALWAYS derived
 *  from the run, never trusted from MCP arguments. */
export function createProductToolsService(deps: ProductToolsServiceDeps): ProductToolsService {
  const { runPort, contextPort, conversationPort, callPort } = deps;

  function assertScope(run: AgentRun, identity: ProductToolCallIdentity): void {
    if (
      run.conversationId !== identity.conversationId ||
      run.agentMemberId !== identity.agentMemberId ||
      run.branchId !== identity.branchId
    ) {
      throw new ProductToolRejectedError(
        `tool call identity mismatch for run ${identity.runId}: scope is (${run.conversationId}, ${run.agentMemberId}, ${run.branchId}), got (${identity.conversationId}, ${identity.agentMemberId}, ${identity.branchId})`,
      );
    }
  }

  /** Messages visible to this agent member: broadcast or addressed to the
   *  member, or sent by the member; never `visibility: internal`. */
  function visibleMessages(
    entries: readonly LedgerEntry[],
    agentMemberId: string,
  ): Array<{ seq: number; message: Message }> {
    const out: Array<{ seq: number; message: Message }> = [];
    for (const e of entries) {
      if (e.kind !== "message") continue;
      // conversation getLedgerEntries already parses content (the port type
      // lies: content is the parsed value, not a JSON string).
      const message = e.content as unknown as Message;
      if (!message || typeof message !== "object") continue;
      if (message.visibility === "internal") continue;
      const addressed = e.addressedTo ?? [];
      const visible =
        addressed.length === 0 ||
        addressed.includes(agentMemberId) ||
        e.senderMemberId === agentMemberId;
      if (visible) out.push({ seq: e.seq, message });
    }
    return out;
  }

  function toResult(items: Array<{ seq: number; message: Message }>): ProductToolCallResult {
    return {
      content: JSON.stringify(
        items.map(({ seq, message }) => ({
          seq,
          role: message.role,
          text: message.text ?? "",
        })),
      ),
    };
  }

  async function historyRecent(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const visible = visibleMessages(entries, run.agentMemberId);
    return toResult(visible.slice(-limit));
  }

  async function historySearch(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const keyword = String(args.keyword ?? "");
    if (!keyword) throw new ProductToolRejectedError("history_search requires a keyword");
    const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), 100);
    // searchLedger is global; scope strictly to this run's conversation.
    const hits = conversationPort
      .searchLedger(keyword, limit * 4)
      .filter((h) => h.conversationId === run.conversationId)
      .slice(0, limit)
      .map((h) => ({
        seq: h.seq,
        role: "message" as const,
        text: h.snippet,
      }));
    return { content: JSON.stringify(hits) };
  }

  async function historyAround(
    run: AgentRun,
    args: Readonly<Record<string, unknown>>,
  ): Promise<ProductToolCallResult> {
    const seq = Number(args.seq);
    if (!Number.isFinite(seq)) throw new ProductToolRejectedError("history_around requires a seq");
    const before = Math.min(Math.max(Number(args.before ?? 5) || 5, 0), 50);
    const after = Math.min(Math.max(Number(args.after ?? 5) || 5, 0), 50);
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const visible = visibleMessages(entries, run.agentMemberId);
    const idx = visible.findIndex((v) => v.seq === seq);
    if (idx === -1) return { content: "[]" };
    return toResult(visible.slice(Math.max(0, idx - before), idx + 1 + after));
  }

  async function historyRetain(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const seq = Number(input.args.seq);
    if (!Number.isFinite(seq)) throw new ProductToolRejectedError("history_retain requires a seq");

    // Durable call idempotency fast path: an existing (runId, callId) row is
    // terminal - replay returns the stored result, a different tool/input
    // conflicts regardless of input validity. The atomic retain below
    // re-checks inside the transaction for concurrent safety.
    const existing = await callPort.getCall(run.runId, input.callId);
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }

    // The message must exist in THIS conversation and be visible to the
    // member (read checks stay outside the mutation transaction).
    const entries = conversationPort.getLedgerEntries(run.conversationId);
    const target = entries.find((e) => e.seq === seq && e.kind === "message");
    if (!target || target.conversationId !== run.conversationId) {
      throw new ProductToolRejectedError(`message ${seq} not found in conversation`);
    }
    const visible = visibleMessages([target], run.agentMemberId);
    if (visible.length === 0) {
      throw new ProductToolRejectedError(`message ${seq} is not visible to this agent member`);
    }

    const branch = await contextPort.getBranch(run.branchId);
    if (!branch) throw new ProductToolRejectedError(`branch not found: ${run.branchId}`);

    // The Context append and the durable call record happen in ONE SQLite
    // transaction: exact replay returns the stored result, a different
    // tool/input conflicts, and concurrent same-call replays produce exactly
    // one Context ref and one call row. inputHash comes from the fast path
    // above (same serialization).
    const result = JSON.stringify({ retained: true, seq });
    const { outcome } = await callPort.retainHistoryMessageOnce({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      branchId: run.branchId,
      ledgerSeq: seq,
      result,
    });
    if (outcome === "conflict") {
      throw new ProductToolRejectedError(
        `call id ${input.callId} reused with a different tool/input`,
      );
    }
    return { content: result };
  }
  const TODO_STATUSES: Record<string, true> = { pending: true, in_progress: true, done: true };

  /** Boundary check on model-supplied items: the durable snapshot is
   *  re-injected into the next run's prompt, so a bad shape (e.g. the
   *  model's `title` habit) would poison every later run's Current Tasks. */
  function isTodoItem(v: unknown): boolean {
    if (!v || typeof v !== "object") return false;
    if (!("id" in v) || !("text" in v) || !("status" in v)) return false;
    const id = v.id;
    const text = v.text;
    const status = v.status;
    return (
      typeof id === "string" &&
      id.length > 0 &&
      typeof text === "string" &&
      text.length > 0 &&
      typeof status === "string" &&
      TODO_STATUSES[status] === true
    );
  }

  async function todoWrite(
    run: AgentRun,
    input: ProductToolCallInput,
  ): Promise<ProductToolCallResult> {
    const items = Array.isArray(input.args.items) ? input.args.items : null;
    if (!items || items.length > 200 || !items.every(isTodoItem)) {
      throw new ProductToolRejectedError(
        "todo_write items must be [{id: string, text: string, status: pending | in_progress | done}] (max 200)",
      );
    }
    const inputHash = JSON.stringify({ tool: input.tool, args: input.args });
    // Same durable idempotency fast path as history_retain.
    const existing = await callPort.getCall(run.runId, input.callId);
    if (existing) {
      if (existing.toolName !== input.tool || existing.inputHash !== inputHash) {
        throw new ProductToolRejectedError(
          `call id ${input.callId} reused with a different tool/input`,
        );
      }
      return { content: existing.result ?? "{}" };
    }
    const snapshot = JSON.stringify(items);
    await runPort.setRunTodoSnapshot(run.runId, snapshot);
    const result = JSON.stringify({ items });
    await callPort.recordCall({
      runId: run.runId,
      callId: input.callId,
      toolName: input.tool,
      inputHash,
      result,
    });
    return { content: result };
  }

  return {
    async call(input) {
      if (input.signal?.aborted) {
        throw new ProductToolRejectedError("product tool call aborted");
      }
      const run = await runPort.getRun(input.identity.runId);
      if (!run) {
        throw new ProductToolRejectedError(`run not found: ${input.identity.runId}`);
      }
      assertScope(run, input.identity);
      // The wire idempotencyKey is defined as `${runId}:${callId}` (Phase 3
      // Product Tool identity). Validate it so a forged/crossed field cannot
      // carry a semantic it does not have.
      if (input.idempotencyKey !== `${run.runId}:${input.callId}`) {
        throw new ProductToolRejectedError(
          `idempotencyKey ${input.idempotencyKey} does not match ${run.runId}:${input.callId}`,
        );
      }
      if (!isActiveStatus(run.status) || run.status !== "running") {
        throw new ProductToolRejectedError(`run ${run.runId} is ${run.status}, not active`);
      }
      const manifest = run.productTools ?? [];
      const declared = manifest.find((t) => t.name === input.tool);
      if (!declared) {
        throw new ProductToolRejectedError(
          `tool ${input.tool} is not declared in run ${run.runId} manifest`,
        );
      }
      switch (input.tool) {
        case "history_recent":
          return historyRecent(run, input.args);
        case "history_search":
          return historySearch(run, input.args);
        case "history_around":
          return historyAround(run, input.args);
        case "history_retain":
          return historyRetain(run, input);
        case "todo_write":
          return todoWrite(run, input);
        default:
          throw new ProductToolRejectedError(`tool ${input.tool} is not supported`);
      }
    },
  };
}
