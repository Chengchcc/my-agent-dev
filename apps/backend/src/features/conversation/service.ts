import type { BackendModelRef } from "@my-agent-team/agent-backend";
import { debugLog } from "@my-agent-team/agent-backend";
import {
  type AgentMember,
  Conversation as ConversationSchema,
  resolveTriggerTargets,
} from "@my-agent-team/conversation";
import type { Message } from "@my-agent-team/message";
import {
  ContentBlockSchema,
  extractText,
  humanMessageId,
  MessageRevisionSchema,
  serializeMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";
import { selectWakeAgentIDs } from "../agent/relationship-service.js";
import type { AgentContextService } from "../agent-context/service.js";
import type { BranchInputMode } from "../agent-run/domain.js";
import type { AgentRunService } from "../agent-run/service.js";
import type { ConversationPort, LedgerEntry, LedgerKind, MemberRow } from "./ports.js";

/** Reserved memberId for the conversation owner (the human who owns an
 *  issue-/cron-spawned conversation). */
export const OWNER_MEMBER_ID = "owner";

function isHumanMember(members: MemberRow[], memberId: string): boolean {
  return members.some((m) => m.memberId === memberId && m.kind === "human");
}

function isSystemSender(memberId: string): boolean {
  return memberId === "__system__";
}

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
  /** Product Context branch resolution (mode decisions; no scope service -
   *  scope IS the Conversation/Member/Branch trio). */
  contextService: AgentContextService;
  /** Effective model for a member's Agent record. */
  resolveDefaultModel: (agentId: string) => Promise<BackendModelRef>;
  maxConsecutiveAgentHops: () => number;
  idGen: () => string;
  /** Wake routing: relationship edges for coordinator selection when
   *  triggerMode=auto and no @mention. */
  getRelationshipEdges?: (
    agentIds: string[],
  ) => Array<{ from: string; to: string; relType: "assigns_to" | "collaborates_with" }>;
}

export interface TriggeredRun {
  agentMemberId: string;
  runId: string;
  queued: boolean;
}

export interface ConversationService {
  port: ConversationPort;
  postMessage(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    content: unknown;
    /** Optional mode override; default: normal when the branch is idle,
     *  steer when a run is active (the caller wants to influence it). */
    mode?: BranchInputMode;
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }>;
  addMember(input: {
    conversationId: string;
    memberId: string;
    kind: "agent" | "human";
    agentId?: string;
    userRef?: string;
    displayName?: string;
  }): Promise<void>;
  removeMember(conversationId: string, memberId: string): Promise<void>;
  subscribeConversation(
    conversationId: string,
    opts?: { afterSeq?: number; signal?: AbortSignal; pollMs?: number },
  ): AsyncIterable<LedgerEntry>;
  /** Mention cascade from a terminal assistant Message: enqueue a run for
   *  every agent member mentioned in the canonical text. Idempotent per
   *  (sourceRunId, targetMemberId) - commit replay cannot double-trigger. */
  cascadeMentionedAgents(input: {
    conversationId: string;
    sourceRunId: string;
    senderMemberId: string;
    message: Message;
  }): Promise<TriggeredRun[]>;
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
   *  Copies members + live (non-undone) ledger entries with seq <= fromSeq. */
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
    senderMemberId: string;
    addressedTo: string[];
  }): Promise<{ newConversationId: string }>;
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
  #maxHops: () => number;
  #idGen: () => string;
  #getRelationshipEdges?: (
    agentIds: string[],
  ) => Array<{ from: string; to: string; relType: "assigns_to" | "collaborates_with" }>;

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
    this.#maxHops = deps.maxConsecutiveAgentHops;
    this.#idGen = deps.idGen;
    this.#getRelationshipEdges = deps.getRelationshipEdges;
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

  /** Load members and build Conversation for pure helpers. */
  #buildConversation(conversationId: string) {
    const convRow = this.port.getConversation(conversationId);
    if (!convRow) return null;
    const allMembers = this.port.getMembers(conversationId).map((m) => ({
      kind: m.kind as "agent" | "human",
      memberId: m.memberId,
      agentId: m.agentId ?? undefined,
      userRef: m.userRef ?? undefined,
      displayName: m.displayName ?? undefined,
    }));
    return ConversationSchema.parse({
      conversationId,
      members: allMembers,
      triggerMode: convRow.triggerMode,
      createdAt: convRow.createdAt,
    });
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

  /** Enqueue an input for one agent member and dispatch when acquired.
   *  All modes persist first (normal/steer/follow_up); never calls an
   *  in-memory session. The idempotency key makes replay safe: same
   *  (branch, key) returns the same input/run without duplicates. */
  async #triggerForMember(input: {
    conversationId: string;
    memberId: string;
    message: Message;
    idempotencyKey: string;
    mode?: BranchInputMode;
  }): Promise<TriggeredRun> {
    const members = this.port.getMembers(input.conversationId);
    const member = members.find((m) => m.memberId === input.memberId);
    if (!member?.agentId) {
      throw new Error(`no agent member ${input.memberId} in ${input.conversationId}`);
    }
    const defaultModel = await this.#resolveDefaultModel(member.agentId);
    const kind = defaultModel.backendKind;
    // The default branch (with any kind-switch fork, D2) is ensured by
    // AgentRunService.enqueueAndAcquire — the single run-creation choke
    // point (conversation, cron and loop all funnel through it).
    const branch = await this.#contextService.getOrCreateDefaultBranch(
      input.conversationId,
      input.memberId,
      kind,
    );
    const active = await this.#agentRuns.getActiveRun(branch.branchId);
    // Auto-inferred routing needs three states, not two:
    //   live child      -> steer (routable now)
    //   dispatch in flight (pre-acceptance) -> follow_up (queued, NEVER aborted)
    //   DB active, neither live nor inflight -> zombie: abort + fresh normal Run
    // An EXPLICIT input.mode is never silently converted.
    let mode: BranchInputMode;
    if (input.mode) {
      mode = input.mode;
    } else if (active && this.#isLive(active.runId)) {
      mode = "steer";
    } else if (active && this.#isInflight(active.runId)) {
      mode = "follow_up";
    } else {
      if (active) await this.#abortStaleRun(active.runId);
      mode = "normal";
    }
    const { acquired, queued, cancelled, run, inputId } = await this.#agentRuns.enqueueAndAcquire({
      conversationId: input.conversationId,
      agentMemberId: input.memberId,
      backendKind: kind,
      mode,
      message: input.message,
      defaultModel,
      configRevision: 1,
      idempotencyKey: input.idempotencyKey,
    });
    debugLog(
      "conversation",
      `trigger conversationId=${input.conversationId} agentMemberId=${input.memberId} branchId=${branch.branchId} mode=${mode} inputId=${inputId} runId=${run?.runId ?? ""} acquired=${acquired} queued=${queued}`,
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
        console.error(`[conversation] steer injection failed for ${input.memberId}:`, err);
      });
    } else if (cancelled) {
      // A steer with no active Run (race between the active check above and
      // the enqueue): the input was cancelled at enqueue - surface it as an
      // explicit error, never a silent drop.
      throw new Error(
        `steer rejected: no active run on branch ${branch.branchId} for ${input.memberId}`,
      );
    }
    return { agentMemberId: input.memberId, runId: run?.runId ?? "", queued };
  }

  /** Parse @mentions / display-name mentions out of a canonical message. */
  #findMentionedAgentMembers(text: string, roster: MemberRow[], excludeMemberId: string): string[] {
    const mentioned: string[] = [];
    for (const m of roster) {
      if (m.kind !== "agent" || m.memberId === excludeMemberId) continue;
      const label = m.displayName ?? m.memberId;
      const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      if (new RegExp(`(^|\\s)@?${escaped}\\b`).test(text) || text.includes(`@${m.memberId}`)) {
        mentioned.push(m.memberId);
      }
    }
    return mentioned;
  }

  // ─── Public API ─────────────────────────────────────

  async postMessage(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    content: unknown;
    mode?: BranchInputMode;
  }): Promise<{ seq: number; triggeredRuns: TriggeredRun[] }> {
    const conv = this.#buildConversation(input.conversationId);
    if (!conv) throw new Error(`Conversation not found: ${input.conversationId}`);

    const members = this.port.getMembers(input.conversationId);
    let targets = resolveTriggerTargets(conv, input.addressedTo);
    // Wake routing: when no @mention and triggerMode=auto, select coordinator
    // from relationship graph
    if (targets.length === 0 && input.addressedTo.length === 0 && conv.triggerMode === "all") {
      const activeAgentIds = members.filter((m) => m.kind === "agent").map((m) => m.memberId);
      const edges = this.#getRelationshipEdges?.(activeAgentIds) ?? [];
      const coordinatorIds = selectWakeAgentIDs(activeAgentIds, [], false, edges);
      targets = coordinatorIds
        .map((id): AgentMember | undefined => {
          const m = conv.members.find((m) => m.memberId === id);
          return m?.kind === "agent" ? m : undefined;
        })
        .filter((m): m is AgentMember => m !== undefined);
    }

    // ── Hop count: reset on human/external, increment only for known agent members ──
    const convRow = this.port.getConversation(input.conversationId);
    const senderIsAgent = members.some(
      (m) => m.memberId === input.senderMemberId && m.kind === "agent",
    );
    if (isHumanMember(members, input.senderMemberId) || isSystemSender(input.senderMemberId)) {
      this.port.updateHopCount(input.conversationId, 0);
    } else if (senderIsAgent) {
      this.port.updateHopCount(input.conversationId, (convRow?.hopCount ?? 0) + 1);
    }

    // ── The human message becomes canonical History FIRST ──
    const userRev = {
      messageId: humanMessageId(input.conversationId, input.senderMemberId),
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
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: "message",
      content: userRev,
    });

    const triggeredRuns: TriggeredRun[] = [];
    const currentHop = this.port.getConversation(input.conversationId)?.hopCount ?? 0;
    const hopCapped = targets.length > 0 && currentHop > this.#maxHops();

    if (targets.length > 0 && !hopCapped) {
      const message: Message = { ...userRev, id: userRev.messageId };
      for (const target of targets) {
        try {
          triggeredRuns.push(
            await this.#triggerForMember({
              conversationId: input.conversationId,
              memberId: target.memberId,
              message,
              idempotencyKey: `${input.conversationId}:${seq}:${target.memberId}`,
              mode: input.mode,
            }),
          );
        } catch (err) {
          console.error(
            `[conversation] enqueueAndAcquire failed for ${target.memberId}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    } else if (hopCapped) {
      // Broadcast system message about the cap (no run)
      const sysRev = {
        messageId: systemMessageId(input.conversationId, "hopcap"),
        role: "system" as const,
        state: "done" as const,
        text: `[系统] 连续 agent->agent 触发达上限（${this.#maxHops()}），已暂停，等待真人介入。`,
        visibility: "conversation" as const,
        updatedAt: Date.now(),
      };
      await this.#appendAndBroadcast({
        conversationId: input.conversationId,
        senderMemberId: "__system__",
        addressedTo: [],
        kind: "message",
        content: sysRev,
      });
    }

    return { seq, triggeredRuns };
  }

  // ─── Member join/leave ──────────────────────────

  async addMember(input: {
    conversationId: string;
    memberId: string;
    kind: "agent" | "human";
    agentId?: string;
    userRef?: string;
    displayName?: string;
  }): Promise<void> {
    const { created } = this.port.addMember({
      memberId: input.memberId,
      conversationId: input.conversationId,
      kind: input.kind,
      agentId: input.agentId,
      userRef: input.userRef,
      displayName: input.displayName,
      joinedAt: Date.now(),
    });

    if (!created) return; // Already a member

    const members = this.port.getMembers(input.conversationId);
    await this.#appendAndBroadcast({
      conversationId: input.conversationId,
      senderMemberId: "__system__",
      addressedTo: [],
      kind: "member.joined",
      content: {
        memberId: input.memberId,
        members: members.map((m) => ({
          memberId: m.memberId,
          kind: m.kind,
          displayName: m.displayName,
        })),
      },
    });
  }

  async removeMember(conversationId: string, memberId: string): Promise<void> {
    const members = this.port.getMembers(conversationId);
    this.port.removeMember(conversationId, memberId);

    await this.#appendAndBroadcast({
      conversationId,
      senderMemberId: "__system__",
      addressedTo: [],
      kind: "member.left",
      content: {
        memberId,
        members: members
          .filter((m) => m.memberId !== memberId)
          .map((m) => ({
            memberId: m.memberId,
            kind: m.kind,
            displayName: m.displayName,
          })),
      },
    });
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

  /** Mention cascade triggered AFTER a terminal assistant Message is
   *  committed (explicit callback from the Agent Run execution service).
   *  Idempotent per (sourceRunId, targetMemberId). */
  async cascadeMentionedAgents(input: {
    conversationId: string;
    sourceRunId: string;
    senderMemberId: string;
    message: Message;
  }): Promise<TriggeredRun[]> {
    const convRow = this.port.getConversation(input.conversationId);
    if (!convRow) return [];
    // Old Runtime behavior: cron-originated conversations do not cascade.
    if (convRow.origin === "cron") return [];
    const text = extractText(input.message);
    if (!text) return [];

    const roster = this.port.getMembers(input.conversationId);
    const targets = this.#findMentionedAgentMembers(text, roster, input.senderMemberId);
    const triggered: TriggeredRun[] = [];
    for (const memberId of targets) {
      try {
        triggered.push(
          await this.#triggerForMember({
            conversationId: input.conversationId,
            memberId,
            message: input.message,
            idempotencyKey: `${input.sourceRunId}:${memberId}`,
            mode: "normal",
          }),
        );
      } catch (err) {
        console.error(
          `[conversation] mention cascade failed for ${memberId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return triggered;
  }

  /** M15.1: Start a fresh conversation from a surface control tool call.
   *  Copies agent + human members, writes surface.control to old ledger. */
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

    // 3. Create new conversation
    const newConversationId = this.#idGen();
    this.port.createConversation({
      conversationId: newConversationId,
      triggerMode: "mention",
      createdAt: Date.now(),
    });
    if (title) {
      this.port.setConversationTitle(newConversationId, title);
    }

    // 4. Copy agent members + Lark human members (NOT history)
    const members = this.port.getMembers(oldConversationId);
    for (const m of members) {
      if (m.kind === "agent" || (m.kind === "human" && m.userRef?.startsWith("lark:"))) {
        this.port.addMember({
          memberId: m.memberId,
          conversationId: newConversationId,
          kind: m.kind,
          agentId: m.agentId,
          userRef: m.userRef,
          displayName: m.displayName,
          joinedAt: Date.now(),
        });
      }
    }

    // 5. Write surface.control entry to OLD conversation ledger
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

    for (const m of this.port.getMembers(input.conversationId)) {
      this.port.addMember({
        conversationId: newId,
        memberId: m.memberId,
        kind: m.kind,
        agentId: m.agentId,
        userRef: m.userRef,
        displayName: m.displayName,
        joinedAt: Date.now(),
      });
    }

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
    senderMemberId: string;
    addressedTo: string[];
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
}
