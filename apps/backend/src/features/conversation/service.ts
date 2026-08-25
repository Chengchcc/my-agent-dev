import type { BackendModelRef } from "@chengchenccc/agent-backend";
import { debugLog } from "@chengchenccc/agent-backend";
import type { Message } from "@chengchenccc/message";
import {
  ContentBlockSchema,
  extractText,
  humanMessageId,
  MessageRevisionSchema,
  serializeMessageRevision,
} from "@chengchenccc/message";
import { DomainError } from "../../infra/domain-errors.js";
import type { AgentContextService } from "../agent-context/service.js";
import type { BranchInputMode } from "../agent-run/domain.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort, LedgerEntry, LedgerKind } from "./ports.js";

export interface ConversationServiceDeps {
  port: ConversationPort;
  /** Phase 4 durable run creation: enqueue + branch acquire. */
  agentRunService: AgentRunService;
  /** Phase 4 execution entry point (dispatch acquired runs). Injected as a
   *  function so composition can break the execution<->cascade cycle. */
  dispatchRun: (runId: string) => Promise<void>;
  /** Best-effort steer injection into the branch's LIVE run (used when the
   *  enqueue queued behind an active run with mode=steer). */
  injectSteer: (branchId: string, input: { inputId: string; message: Message }) => Promise<void>;
  /** Live-child probe: true when the run has an in-process child. DB-active
   *  alone is NOT enough (restart / pre-acceptance failure leaves a zombie
   *  active run with no live child). */
  isLive: (runId: string) => boolean;
  /** Dispatch-in-flight probe: the run is being dispatched (pre-acceptance)
   *  on this process. Auto-routing queues such runs as follow-up and never
   *  aborts them. */
  isInflight: (runId: string) => boolean;
  /** Terminal a zombie run (DB active, no live child, not in flight):
   *  aborted + input cancelled + branch released, before enqueueing a fresh
   *  normal Run. */
  abortStaleRun: (runId: string) => Promise<void>;
  /** Product Context branch resolution (mode decisions; scope IS the
   *  Conversation/Branch pair since the 1:1 collapse). */
  contextService: AgentContextService;
  /** Effective model for the conversation's Agent record. */
  resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;

  idGen: () => string;
}

export interface TriggeredRun {
  agentId: string;
  runId: string;
  queued: boolean;
}

export interface ConversationService {
  port: ConversationPort;
  postMessage(input: {
    conversationId: string;
    /** Optional explicit override (lark group mentions). Derived when absent:
     *  sender = the constant "user", targets = the conversation's agent. */
    senderMemberId?: string;
    addressedTo?: string[];
    content: unknown;
    /** Optional mode override; default: normal when the branch is idle,
     *  steer when a run is active (the caller wants to influence it). */
    mode?: BranchInputMode;
    /** Per-input model override (same-kind guard applies). */
    modelOverride?: BackendModelRef;
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }>;
  subscribeConversation(
    conversationId: string,
    opts?: { afterSeq?: number; signal?: AbortSignal; pollMs?: number },
  ): AsyncIterable<LedgerEntry>;
  startNewConversationForSurface(input: {
    oldConversationId: string;
    reason: string;
    title?: string;
    requestedByRunId: string;
    idempotencyKey: string;
  }): Promise<{ oldConversationId: string; newConversationId: string; controlSeq: number }>;
  clearConversation(conversationId: string): Promise<void>;
  compactConversation(conversationId: string): Promise<void>;
  /** Fork a conversation from a ledger seq into a new conversation.
   *  Copies the agent binding + live (non-undone) ledger entries with seq <= fromSeq. */
  forkConversation(input: {
    conversationId: string;
    fromSeq: number;
    title?: string;
  }): Promise<{ newConversationId: string }>;
  /** Soft-delete the most recent N live message entries (undo). */
  undoMessages(input: {
    conversationId: string;
    count?: number;
  }): Promise<{ undoneSeqs: number[] }>;
  /** Fork from fromSeq-1, append an edited user message, trigger agent run (replay). */
  replayFromMessage(input: {
    conversationId: string;
    fromSeq: number;
    editedContent: string;
    /** Optional explicit override; derived on the fork when absent. */
    senderMemberId?: string;
    addressedTo?: string[];
  }): Promise<{ newConversationId: string }>;

  // ─── Pending input queue (Composer queue area) ───
  /** Pending inputs across the conversation's agent branches, oldest first. */
  listPendingInputs(conversationId: string): Promise<
    Array<{
      inputId: string;
      branchId: string;
      mode: BranchInputMode;
      text: string;
      agentId: string;
      createdAt: number;
    }>
  >;
  /** Inject a queued input into the branch's LIVE run ("Send now"). Throws
   *  when the input is gone or no longer pending. */
  steerInput(inputId: string): Promise<void>;
  /** CAS a pending input's message; false when no longer pending. */
  updateInput(inputId: string, text: string): Promise<boolean>;
  /** CAS a pending/delivering input to cancelled (idempotent). */
  cancelInput(inputId: string): Promise<void>;
}

export function createConversationService(deps: ConversationServiceDeps): ConversationService {
  return new ConversationServiceImpl(deps);
}

class ConversationServiceImpl implements ConversationService {
  readonly port: ConversationPort;
  #agentRuns: AgentRunService;
  #dispatchRun: (runId: string) => Promise<void>;
  #injectSteer: ConversationServiceDeps["injectSteer"];
  #isLive: ConversationServiceDeps["isLive"];
  #isInflight: ConversationServiceDeps["isInflight"];
  #abortStaleRun: ConversationServiceDeps["abortStaleRun"];
  #contextService: AgentContextService;
  #resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;

  #idGen: () => string;

  // Push-based SSE: subscribers are notified immediately when new ledger
  // entries are appended.
  #subscribers = new Map<string, Set<(entry: LedgerEntry) => void>>();

  constructor(deps: ConversationServiceDeps) {
    this.port = deps.port;
    this.#agentRuns = deps.agentRunService;
    this.#dispatchRun = deps.dispatchRun;
    this.#injectSteer = deps.injectSteer;
    this.#isLive = deps.isLive;
    this.#isInflight = deps.isInflight;
    this.#abortStaleRun = deps.abortStaleRun;
    this.#contextService = deps.contextService;
    this.#resolveDefaultModel = deps.resolveDefaultModel;
    this.#idGen = deps.idGen;
  }

  // ─── Private helpers ───────────────────────────────

  #notify(conversationId: string, entry: LedgerEntry) {
    const subs = this.#subscribers.get(conversationId);
    if (!subs) return;
    for (const sub of subs) {
      try {
        sub(entry);
      } catch (e) {
        console.error(`[conversation] subscriber error for ${conversationId}:`, e);
      }
    }
  }

  /** Append a ledger entry and broadcast it to subscribers. Returns seq.
   *  For kind:"message", content MUST be a MessageRevision. */
  async #appendAndBroadcast(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    kind: LedgerKind;
    content: unknown;
  }): Promise<number> {
    const ts = Date.now();
    const serialized =
      input.kind === "message"
        ? serializeMessageRevision(MessageRevisionSchema.parse(input.content) as never)
        : JSON.stringify(input.content);
    const seq = this.port.appendLedgerEntry({
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: input.kind,
      content: serialized,
      ts,
    });
    const entry: LedgerEntry = {
      seq,
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: input.kind,
      content: serialized,
      ts,
    };
    this.#notify(input.conversationId, entry);
    return seq;
  }

  /** Enqueue an input for the conversation's agent and dispatch when acquired.
   *  All modes persist first (normal/steer/follow_up); never calls an
   *  in-memory session. The idempotency key makes replay safe: same
   *  (branch, key) returns the same input/run without duplicates. */
  async #triggerForAgent(input: {
    conversationId: string;
    agentId: string;
    message: Message;
    idempotencyKey: string;
    mode?: BranchInputMode;
    /** Per-input model override; honored only when its backendKind matches
     *  the agent's default kind (foreign-kind refs would break the branch). */
    modelOverride?: BackendModelRef;
  }): Promise<TriggeredRun> {
    const resolved = await this.#resolveDefaultModel(input.agentId);
    const defaultModel =
      input.modelOverride && input.modelOverride.backendKind === resolved.backendKind
        ? input.modelOverride
        : resolved;
    const kind = defaultModel.backendKind;
    // The default branch (with any kind-switch fork, D2) is ensured by
    // AgentRunService.enqueueAndAcquire — the single run-creation choke
    // point (conversation, cron and loop all funnel through it).
    const branch = await this.#contextService.getOrCreateDefaultBranch(input.conversationId, kind);
    const active = await this.#agentRuns.getActiveRun(branch.branchId);
    // CLI backends run one short-lived process per turn with no mid-turn
    // steer (ADR 0002): a steer input is queued as the NEXT turn's input
    // instead of being injected into a live child (and never silently
    // dropped — the input is durable in branch_input_queue).
    const cliBackend = kind !== "oma";
    // Auto-inferred routing needs three states, not two:
    //   live child      -> steer (routable now)
    //   dispatch in flight (pre-acceptance) -> follow_up (queued, NEVER aborted)
    //   DB active, neither live nor inflight -> zombie: abort + fresh normal Run
    // An EXPLICIT input.mode is never silently converted — except steer on a
    // CLI backend, which by design queues as the next turn.
    let mode: BranchInputMode;
    if (input.mode === "steer" && cliBackend) {
      mode = "normal";
    } else if (input.mode) {
      mode = input.mode;
    } else if (active && this.#isLive(active.runId)) {
      mode = cliBackend ? "normal" : "steer";
    } else if (active && this.#isInflight(active.runId)) {
      mode = "follow_up";
    } else {
      if (active) await this.#abortStaleRun(active.runId);
      mode = "normal";
    }
    const { acquired, queued, cancelled, run, inputId } = await this.#agentRuns.enqueueAndAcquire({
      conversationId: input.conversationId,
      agentId: input.agentId,
      backendKind: kind,
      mode,
      message: input.message,
      defaultModel,
      configRevision: 1,
      idempotencyKey: input.idempotencyKey,
    });
    debugLog(
      "conversation",
      `trigger conversationId=${input.conversationId} agentId=${input.agentId} branchId=${branch.branchId} mode=${mode} inputId=${inputId} runId=${run?.runId ?? ""} acquired=${acquired} queued=${queued}`,
    );
    if (acquired && run) {
      void this.#dispatchRun(run.runId).catch((err) => {
        console.error(`[conversation] dispatch failed for ${run.runId}:`, err);
      });
    } else if (queued && mode === "steer") {
      // Steer belongs to the CURRENT active run: inject it into the live
      // loop right away (one Run / one loop - it never starts a new
      // segment). If the run has already settled, injection fails and the
      // input is cancelled - a steer is never replayed as a normal input.
      void this.#injectSteer(branch.branchId, {
        inputId,
        message: input.message,
      }).catch((err) => {
        console.error(`[conversation] steer injection failed for ${input.agentId}:`, err);
      });
    } else if (cancelled) {
      // A steer with no active Run (race between the active check above and
      // the enqueue): the input was cancelled at enqueue - surface it as an
      // explicit error, never a silent drop.
      throw new Error(
        `steer rejected: no active run on branch ${branch.branchId} for ${input.agentId}`,
      );
    }
    return { agentId: input.agentId, runId: run?.runId ?? "", queued };
  }

  // ─── Public API ─────────────────────────────────────

  async postMessage(input: {
    conversationId: string;
    /** Optional explicit override (lark group mentions). Derived when absent:
     *  sender = the constant "user", targets = the conversation's agent. */
    senderMemberId?: string;
    addressedTo?: string[];
    content: unknown;
    mode?: BranchInputMode;
    modelOverride?: BackendModelRef;
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }> {
    const convRow = this.port.getConversation(input.conversationId);
    if (!convRow) throw new Error(`Conversation not found: ${input.conversationId}`);

    const agentId = convRow.agentId;
    const senderMemberId = input.senderMemberId ?? "user";
    // 1:1: absent addressedTo targets the conversation's agent; an explicit
    // override only triggers when it mentions THIS agent (lark group).
    const trigger = agentId !== null && (input.addressedTo ?? [agentId]).includes(agentId);

    // ── The human message becomes canonical History FIRST ──
    const userRev = {
      messageId: humanMessageId(input.conversationId, senderMemberId),
      role: "user" as const,
      state: "done" as const,
      text: typeof input.content === "string" ? input.content : undefined,
      blocks: Array.isArray(input.content)
        ? (ContentBlockSchema.array().parse(input.content) as never)
        : undefined,
      conversationId: input.conversationId,
      visibility: "conversation" as const,
      updatedAt: Date.now(),
    };
    const seq = await this.#appendAndBroadcast({
      conversationId: input.conversationId,
      senderMemberId,
      addressedTo: input.addressedTo ?? (agentId ? [agentId] : []),
      kind: "message",
      content: userRev,
    });

    const triggeredRuns: TriggeredRun[] = [];
    if (trigger) {
      const message: Message = { ...userRev, id: userRev.messageId };
      try {
        triggeredRuns.push(
          await this.#triggerForAgent({
            conversationId: input.conversationId,
            agentId: agentId!,
            message,
            idempotencyKey: `${input.conversationId}:${seq}:${agentId}`,
            mode: input.mode,
            modelOverride: input.modelOverride,
          }),
        );
      } catch (err) {
        if (err instanceof DomainError) throw err;
        console.error(
          `[conversation] enqueueAndAcquire failed for ${agentId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return { seq, triggeredRuns };
  }

  // ─── SSE projection ─────────────────────────────

  async *subscribeConversation(
    conversationId: string,
    opts?: { afterSeq?: number; signal?: AbortSignal; pollMs?: number },
  ): AsyncIterable<LedgerEntry> {
    const since = opts?.afterSeq ?? 0;
    const pollMs = opts?.pollMs ?? 100;
    let lastSeq = since;
    let silentPolls = 0;
    const heartbeatInterval = 3;

    const pushBuffer: LedgerEntry[] = [];
    let pushResolver: (() => void) | null = null;
    const onPush = (entry: LedgerEntry) => {
      pushBuffer.push(entry);
      pushResolver?.();
    };
    const subs = this.#subscribers.get(conversationId) ?? new Set();
    subs.add(onPush);
    this.#subscribers.set(conversationId, subs);

    try {
      // First, yield all existing entries (catch up)
      const initial = this.port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
      for (const entry of initial) {
        yield entry;
        lastSeq = entry.seq;
      }

      while (true) {
        if (opts?.signal?.aborted) break;

        while (pushBuffer.length > 0) {
          const entry = pushBuffer.shift()!;
          yield entry;
          if (entry.seq > lastSeq) lastSeq = entry.seq;
          silentPolls = 0;
        }

        if (pollMs === 0) break;

        if (pushBuffer.length === 0) {
          const pushPromise = new Promise<void>((r) => {
            pushResolver = r;
          });
          const pollTimeout = new Promise<void>((r) => setTimeout(r, 5000));
          await Promise.race([pushPromise, pollTimeout]);
          pushResolver = null;

          while (pushBuffer.length > 0) {
            const entry = pushBuffer.shift()!;
            yield entry;
            if (entry.seq > lastSeq) lastSeq = entry.seq;
          }

          const entries = this.port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
          if (entries.length > 0) {
            for (const entry of entries) {
              yield entry;
              lastSeq = entry.seq;
            }
            silentPolls = 0;
          } else {
            silentPolls++;
            if (silentPolls % heartbeatInterval === 0) {
              yield {
                seq: 0,
                conversationId,
                senderMemberId: "",
                addressedTo: [],
                kind: "message" as const,
                content: "",
                ts: Date.now(),
                _heartbeat: true as const,
              } as LedgerEntry & { _heartbeat: true };
            }
          }
        }
      }
    } finally {
      subs.delete(onPush);
      if (subs.size === 0) this.#subscribers.delete(conversationId);
    }
  }

  /** M15.1: Start a fresh conversation from a surface control tool call.
   *  Copies the agent binding (NOT history), writes surface.control to the
   *  old ledger; the lark watcher rebinds its own delivery tables. */
  async startNewConversationForSurface(input: {
    oldConversationId: string;
    reason: string;
    title?: string;
    requestedByRunId: string;
    idempotencyKey: string;
  }): Promise<{ oldConversationId: string; newConversationId: string; controlSeq: number }> {
    const { oldConversationId, reason, title, requestedByRunId, idempotencyKey } = input;

    // 1. Idempotency: check if this control was already written
    const existingEntries = this.port.getLedgerEntries(oldConversationId);
    for (const entry of existingEntries) {
      if (entry.kind !== "surface.control") continue;
      try {
        const raw = typeof entry.content === "string" ? JSON.parse(entry.content) : entry.content;
        const c = raw as {
          type: string;
          requestedByRunId: string;
          newConversationId: string;
          idempotencyKey?: string;
        };
        if (c.type === "lark.start_new_conversation" && c.idempotencyKey === idempotencyKey) {
          return {
            oldConversationId,
            newConversationId: c.newConversationId,
            controlSeq: entry.seq,
          };
        }
      } catch {
        /* malformed entry - skip */
      }
    }

    // 2. Verify the run owns the old conversation (Agent Run, not span)
    const run = await this.#agentRuns.getRun(requestedByRunId);
    if (!run) throw new Error(`run not found: ${requestedByRunId}`);
    if (run.conversationId !== oldConversationId) {
      throw new Error(
        `run ${requestedByRunId} does not belong to conversation ${oldConversationId}`,
      );
    }

    // 3. Create new conversation with the same agent
    const source = this.port.getConversation(oldConversationId);
    const newConversationId = this.#idGen();
    this.port.createConversation({
      conversationId: newConversationId,
      agentId: source?.agentId ?? null,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    if (title) {
      this.port.setConversationTitle(newConversationId, title);
    }

    // 4. Write surface.control entry to OLD conversation ledger
    const control = {
      type: "lark.start_new_conversation",
      oldConversationId,
      newConversationId,
      reason,
      requestedByRunId,
      idempotencyKey,
    };
    const controlSeq = await this.#appendAndBroadcast({
      conversationId: oldConversationId,
      senderMemberId: "__system__",
      addressedTo: [],
      kind: "surface.control",
      content: control,
    });

    return { oldConversationId, newConversationId, controlSeq };
  }

  /** /clear: no canonical Product Context reset exists (Agent Context is
   *  durable History). Old Runtime session disposal is gone with Phase 5 -
   *  nothing in-memory remains to clear. */
  async clearConversation(_conversationId: string): Promise<void> {
    return;
  }

  /** /compact: no canonical Product summary policy exists; Coding Session
   *  compaction is gone. Explicitly unsupported (no-op). */
  async compactConversation(_conversationId: string): Promise<void> {
    return;
  }

  // ─── Fork / Undo / Replay ───────────────────────

  async forkConversation(input: {
    conversationId: string;
    fromSeq: number;
    title?: string;
  }): Promise<{ newConversationId: string }> {
    const source = this.port.getConversation(input.conversationId);
    if (!source) throw new Error(`Conversation not found: ${input.conversationId}`);

    const newId = this.#idGen();
    this.port.createConversation({
      conversationId: newId,
      agentId: source.agentId,
      triggerMode: source.triggerMode,
      origin: "fork",
      createdAt: Date.now(),
      forkSource: input.conversationId,
      forkFromSeq: input.fromSeq,
    });
    this.port.setConversationTitle(
      newId,
      input.title ?? `Fork of ${input.conversationId.slice(0, 8)}`,
    );

    const entries = this.port
      .getLedgerEntries(input.conversationId)
      .filter((e) => e.seq <= input.fromSeq && !e.undone);
    for (const entry of entries) {
      this.port.appendLedgerEntry({
        conversationId: newId,
        senderMemberId: entry.senderMemberId,
        addressedTo: entry.addressedTo,
        kind: entry.kind,
        content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
        ts: entry.ts,
      });
    }

    return { newConversationId: newId };
  }

  async undoMessages(input: {
    conversationId: string;
    count?: number;
  }): Promise<{ undoneSeqs: number[] }> {
    const count = input.count ?? 1;
    const entries = this.port
      .getLedgerEntries(input.conversationId)
      .filter((e) => e.kind === "message" && !e.undone);
    const toUndo = entries.slice(-count);
    const undoneSeqs: number[] = [];
    for (const entry of toUndo) {
      this.port.markLedgerEntryUndone?.(input.conversationId, entry.seq);
      undoneSeqs.push(entry.seq);
    }
    if (undoneSeqs.length > 0) {
      await this.#appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "undo",
        content: { undoneSeqs },
      });
    }
    return { undoneSeqs };
  }

  async replayFromMessage(input: {
    conversationId: string;
    fromSeq: number;
    editedContent: string;
    /** Optional explicit override; derived on the fork when absent. */
    senderMemberId?: string;
    addressedTo?: string[];
  }): Promise<{ newConversationId: string }> {
    const { newConversationId } = await this.forkConversation({
      conversationId: input.conversationId,
      fromSeq: input.fromSeq - 1,
    });
    await this.postMessage({
      conversationId: newConversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      content: input.editedContent,
    });
    return { newConversationId };
  }

  // ─── Pending input queue (Composer queue area) ───

  async listPendingInputs(conversationId: string) {
    const inputs = await this.#agentRuns.listPendingInputsForConversation(conversationId);
    return inputs.map((i) => ({
      inputId: i.inputId,
      branchId: i.branchId,
      mode: i.mode,
      text: extractText(i.message),
      agentId: i.agentId,
      createdAt: i.createdAt,
    }));
  }

  async steerInput(inputId: string): Promise<void> {
    const input = await this.#agentRuns.getInput(inputId);
    if (!input) throw new Error("Input not found");
    if (input.status !== "pending") throw new Error("Input is no longer pending");
    await this.#injectSteer(input.branchId, { inputId, message: input.message });
  }

  async updateInput(inputId: string, text: string): Promise<boolean> {
    return this.#agentRuns.updateInput(inputId, { role: "user", text });
  }

  async cancelInput(inputId: string): Promise<void> {
    return this.#agentRuns.cancelInput(inputId);
  }
}
