import {
  type AgentMember,
  Conversation as ConversationSchema,
  resolveTriggerTargets,
} from "@my-agent-team/conversation";
import type { MessageRevision } from "@my-agent-team/message";
import {
  ContentBlockSchema,
  humanMessageId,
  MessageRevisionSchema,
  serializeMessageRevision,
  systemMessageId,
} from "@my-agent-team/message";
import { BusyError } from "../../infra/domain-errors.js";
import { selectWakeAgentIDs } from "../agent/relationship-service.js";
import type { ConversationLock } from "./lock.js";
import type { ConversationPort, LedgerEntry, LedgerKind, MemberRow } from "./ports.js";

export class ConversationBusyError extends BusyError {}

/** Reserved memberId for the conversation owner (the human who owns an
 *  issue-/cron-spawned conversation). It is a member id, NOT an agent id -
 *  sessionIds derived from it (`${conversationId}:${OWNER_MEMBER_ID}`) follow
 *  the standard `${conversationId}:${memberId}` shape, not the agent shape. */
export const OWNER_MEMBER_ID = "owner";

function isHumanMember(members: MemberRow[], memberId: string): boolean {
  return members.some((m) => m.memberId === memberId && m.kind === "human");
}

function isSystemSender(memberId: string): boolean {
  return memberId === "__system__";
}

export interface ConversationServiceDeps {
  port: ConversationPort;
  /** M17.5 P4: ConversationLock replaces ad-hoc activeConversations Set + pendingRuns Map. */
  lock: ConversationLock;
  maxConsecutiveAgentHops: () => number;
  /** Active agent sessions: outer key = conversationId, inner key = agentMemberId.
   *  Enables steer (during run) and followUp (after run), directed per addressedTo. */
  activeSessions: Map<
    string,
    Map<
      string,
      {
        steer: (text: string) => void;
        followUp: (text: string) => void;
      }
    >
  >;
  startAgentRun: (
    spanId: string,
    ctx: {
      conversationId: string;
      agentMemberId: string;
      agentId: string;
      ledgerSeq: number;
      /** The user's input text - passed through to Agent.prompt() so the agent receives the actual message. */
      input?: string;
    },
  ) => Promise<{ spanId: string; attemptSeq: number }>;
  idGen: () => string;
  /** Verify a spanId belongs to the given conversation. Throws if not. */
  verifyRunOwnsConversation?: (spanId: string, conversationId: string) => Promise<void>;
  /** Callback to dispose active sessions and clear bindings (for /clear command). */
  onClear?: (conversationId: string) => void;
  /** Callback to compact active sessions (for /compact command). */
  onCompact?: (conversationId: string) => Promise<void>;
  /** Wake routing: returns relationship edges for coordinator selection when triggerMode=auto and no @mention. */
  getRelationshipEdges?: (
    agentIds: string[],
  ) => Array<{ from: string; to: string; relType: "assigns_to" | "collaborates_with" }>;
}

export interface ConversationService {
  port: ConversationPort;
  postMessage(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    content: unknown;
  }): Promise<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; spanId: string }> }>;
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
  appendTodo(conversationId: string, senderMemberId: string, todos: unknown): Promise<void>;
  completeRun(conversationId: string, _spanId: string, agentMemberId?: string): void;
  appendAssistantMessage(input: {
    conversationId: string;
    senderMemberId: string;
    spanId: string;
    revision: MessageRevision;
  }): Promise<number>;
  triggerMentionedAgents(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
  }): Promise<Array<{ agentMemberId: string; spanId: string }>>;
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
  #lock: ConversationLock;
  #maxHops: () => number;
  #activeSessions: ConversationServiceDeps["activeSessions"];
  #startAgentRun: ConversationServiceDeps["startAgentRun"];
  #idGen: () => string;
  #verifyRunOwnsConversation?: (spanId: string, conversationId: string) => Promise<void>;
  #onClear?: (conversationId: string) => void;
  #onCompact?: (conversationId: string) => Promise<void>;
  #getRelationshipEdges?: (
    agentIds: string[],
  ) => Array<{ from: string; to: string; relType: "assigns_to" | "collaborates_with" }>;

  // Push-based SSE: subscribers are notified immediately when new ledger
  // entries are appended, so streaming revisions arrive without poll delay.
  #subscribers = new Map<string, Set<(entry: LedgerEntry) => void>>();

  // Track seq per spanId so streaming revisions UPDATE the same row
  // instead of INSERTing a new row for every model chunk.
  #streamingSeq = new Map<string, number>();

  constructor(deps: ConversationServiceDeps) {
    this.port = deps.port;
    this.#lock = deps.lock;
    this.#maxHops = deps.maxConsecutiveAgentHops;
    this.#activeSessions = deps.activeSessions;
    this.#startAgentRun = deps.startAgentRun;
    this.#idGen = deps.idGen;
    this.#verifyRunOwnsConversation = deps.verifyRunOwnsConversation;
    this.#onClear = deps.onClear;
    this.#onCompact = deps.onCompact;
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

  /** Append a ledger entry and broadcast it to all agent checkpoints. Returns seq.
   *  For kind:"message", content MUST be a MessageRevision - validated via
   *  serializeMessageRevision. Other kinds use plain JSON.stringify. */
  async #appendAndBroadcast(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    kind: LedgerKind;
    content: unknown;
    /** When false, skip thread_projection write (startAgentRun reads from ledger directly). */
    broadcast?: boolean;
  }): Promise<number> {
    const ts = Date.now();
    const serialized =
      input.kind === "message"
        ? serializeMessageRevision(MessageRevisionSchema.parse(input.content) as MessageRevision)
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

  /** Shared fork-run loop: lock conversation, fork runs for targets, release when all complete.
   *  Returns triggered run IDs. Errors for individual targets are logged and skipped. */
  async #forkAgentRuns(
    conversationId: string,
    targets: Array<{ memberId: string; agentId: string }>,
    ledgerSeq: number,
    input?: string,
  ): Promise<Array<{ agentMemberId: string; spanId: string }>> {
    const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];
    this.#lock.acquire(conversationId, targets.length);
    for (const target of targets) {
      try {
        const spanId = crypto.randomUUID();
        const { spanId: rId } = await this.#startAgentRun(spanId, {
          conversationId,
          agentMemberId: target.memberId,
          agentId: target.agentId,
          ledgerSeq,
          input,
        });
        triggeredRuns.push({ agentMemberId: target.memberId, spanId: rId });
      } catch (err) {
        console.error(
          `[conversation] startAgentRun failed for ${target.memberId}:`,
          err instanceof Error ? err.message : String(err),
        );
        // Decrement pending count for failed fork
        this.#lock.releaseOne(conversationId);
      }
    }
    return triggeredRuns;
  }

  // ─── Public API ─────────────────────────────────────

  async postMessage(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
    content: unknown;
  }): Promise<{ seq: number; triggeredRuns: Array<{ agentMemberId: string; spanId: string }> }> {
    const conv = this.#buildConversation(input.conversationId);
    if (!conv) throw new Error(`Conversation not found: ${input.conversationId}`);

    const members = this.port.getMembers(input.conversationId);
    let targets = resolveTriggerTargets(conv, input.addressedTo);
    // Wake routing: when no @mention and triggerMode=auto, select coordinator from relationship graph
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
    const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];

    // ── Hop count: reset on human/external, increment only for known agent members ──
    const convRow = this.port.getConversation(input.conversationId);
    const senderIsAgent = members.some(
      (m) => m.memberId === input.senderMemberId && m.kind === "agent",
    );
    if (isHumanMember(members, input.senderMemberId) || isSystemSender(input.senderMemberId)) {
      this.port.updateHopCount(input.conversationId, 0);
    } else if (senderIsAgent) {
      // L4: only increment for known agent members (not unknown senders)
      this.port.updateHopCount(input.conversationId, (convRow?.hopCount ?? 0) + 1);
    }
    // Unknown senders: unchanged hop count

    // ── Guards: check BEFORE writing (C3 fix) ──

    let hopCapped = false;
    if (targets.length > 0) {
      // Single-active guard
      if (this.#lock.isActive(input.conversationId)) {
        // Busy -> steer to active session instead of rejecting with 409
        const convSessions = this.#activeSessions.get(input.conversationId);
        if (convSessions && convSessions.size > 0) {
          // Find the target agent's session; fall back to first available
          const targetAgentId = input.addressedTo.find((id) => convSessions.has(id));
          const target = targetAgentId
            ? convSessions.get(targetAgentId)
            : convSessions.values().next().value;
          if (target) {
            const userRev: MessageRevision = {
              messageId: humanMessageId(input.conversationId, input.senderMemberId),
              role: "user",
              state: "done",
              text: typeof input.content === "string" ? input.content : undefined,
              blocks: Array.isArray(input.content)
                ? (ContentBlockSchema.array().parse(input.content) as MessageRevision["blocks"])
                : undefined,
              conversationId: input.conversationId,
              visibility: "conversation",
              updatedAt: Date.now(),
            };
            const steerSeq = await this.#appendAndBroadcast({
              conversationId: input.conversationId,
              senderMemberId: input.senderMemberId,
              addressedTo: input.addressedTo,
              kind: "message",
              content: userRev,
              broadcast: true,
            });
            const userText = typeof input.content === "string" ? input.content : "";
            target.steer(userText);
            return { seq: steerSeq, triggeredRuns: [] };
          }
        }
        throw new ConversationBusyError(input.conversationId);
      }
      // Hop hard-cap check (after hop count update, so human reset takes effect)
      const currentHop = this.port.getConversation(input.conversationId)?.hopCount ?? 0;
      hopCapped = currentHop > this.#maxHops();
    }

    // ── Append this message to ledger as a MessageRevision (no broadcast - startAgentRun reads from ledger) ──
    const userRev: MessageRevision = {
      // M17.2 fix: use UUID to prevent same-ms collision when
      // the ledger is folded by messageId. Two posts in the same millisecond
      // would share an id and the second would silently overwrite the first.
      messageId: humanMessageId(input.conversationId, input.senderMemberId),

      role: "user",
      state: "done",
      text: typeof input.content === "string" ? input.content : undefined,
      blocks: Array.isArray(input.content)
        ? (ContentBlockSchema.array().parse(input.content) as MessageRevision["blocks"])
        : undefined,
      conversationId: input.conversationId,
      visibility: "conversation",
      updatedAt: Date.now(),
    };
    const seq = await this.#appendAndBroadcast({
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: input.addressedTo,
      kind: "message",
      content: userRev,
      broadcast: false,
    });
    // If session is still alive, followUp reuses its memory (no new fork)
    if (targets.length > 0 && !hopCapped) {
      const convSessions = this.#activeSessions.get(input.conversationId);
      if (convSessions && convSessions.size > 0) {
        const targetAgentId = input.addressedTo.find((id) => convSessions.has(id));
        const target = targetAgentId
          ? convSessions.get(targetAgentId)
          : convSessions.values().next().value;
        if (target) {
          const userText = typeof input.content === "string" ? input.content : "";
          target.followUp(userText);
          return { seq, triggeredRuns: [] };
        }
      }
    }

    // ── @ trigger: fork agent run for each target (skip if hop-capped) ──
    if (targets.length > 0 && !hopCapped) {
      const userText = typeof input.content === "string" ? input.content : "";
      const runs = await this.#forkAgentRuns(input.conversationId, targets, seq, userText);
      triggeredRuns.push(...runs);
    } else if (hopCapped) {
      // Broadcast system message about the cap (no fork)
      const sysRev: MessageRevision = {
        messageId: systemMessageId(input.conversationId, "hopcap"),
        role: "system",
        state: "done",
        text: `[系统] 连续 agent->agent 触发达上限（${this.#maxHops()}），已暂停，等待真人介入。`,
        visibility: "conversation",
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

    if (!created) return; // Already a member - don't re-broadcast member.joined

    // Broadcast system message
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
    // Heartbeat: every 3rd 5s fallback cycle (~15s) so sseResponse can emit
    // an SSE comment to keep the connection alive.
    const heartbeatInterval = 3;

    // Push buffer - drained before each poll so streaming revisions
    // delivered via notify() are yielded instantly via push, not after a
    // poll cycle. When the buffer is empty, we wait for a push OR a 5s
    // poll timeout (fallback for missed pushes), then drain + do one DB
    // poll to catch anything notify() missed.
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

      // Then loop: push-first, poll-fallback. No idle timeout.
      // pollMs=0 means one-shot (tests); otherwise stay alive indefinitely.
      while (true) {
        if (opts?.signal?.aborted) break;

        // Drain push buffer first (entries delivered via notify).
        // Push entries are always yielded regardless of seq - streaming
        // revisions get a real monotonic seq via the streamingSeq map, and
        // the heartbeat sentinel uses seq:0, so neither hits the >lastSeq guard.
        while (pushBuffer.length > 0) {
          const entry = pushBuffer.shift()!;
          yield entry;
          if (entry.seq > lastSeq) lastSeq = entry.seq;
          silentPolls = 0;
        }

        // One-shot (tests): after catch-up + one drain, break.
        if (pollMs === 0) break;

        // Buffer empty: wait for a push OR a 5s poll timeout (fallback).
        // The push path delivers entries instantly; the 5s timeout catches
        // any push missed (e.g. a subscriber registered after notify()).
        if (pushBuffer.length === 0) {
          const pushPromise = new Promise<void>((r) => {
            pushResolver = r;
          });
          const pollTimeout = new Promise<void>((r) => setTimeout(r, 5000));
          await Promise.race([pushPromise, pollTimeout]);
          pushResolver = null;

          // Drain whatever push delivered.
          while (pushBuffer.length > 0) {
            const entry = pushBuffer.shift()!;
            yield entry;
            if (entry.seq > lastSeq) lastSeq = entry.seq;
          }

          // Fallback DB poll: catch entries notify() missed.
          const entries = this.port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
          if (entries.length > 0) {
            for (const entry of entries) {
              yield entry;
              lastSeq = entry.seq;
            }
            silentPolls = 0;
          } else {
            silentPolls++;
            // Heartbeat: yield a sentinel row every ~15s so sseResponse
            // can emit an SSE comment to keep the connection alive.
            // Frontend EventSource ignores SSE comments (not a business event).
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

  /** M14.6: Append a todo snapshot to the conversation ledger (UI-only, not projected to agents). */
  async appendTodo(conversationId: string, senderMemberId: string, todos: unknown): Promise<void> {
    await this.#appendAndBroadcast({
      conversationId,
      senderMemberId,
      addressedTo: [],
      kind: "todo",
      content: { todos },
    });
  }

  /** Release the conversation lock when ALL triggered runs complete.
   *  agentMemberId optional: when provided, only that agent's session is removed
   *  (other agents in the same conversation keep theirs). Falls back to clearing
   *  the whole conversation when omitted (legacy callers / unknown origin). */
  completeRun(conversationId: string, _spanId: string, agentMemberId?: string): void {
    this.#lock.releaseOne(conversationId);
    const convSessions = this.#activeSessions.get(conversationId);
    if (convSessions) {
      if (agentMemberId) {
        convSessions.delete(agentMemberId);
        if (convSessions.size === 0) {
          this.#activeSessions.delete(conversationId);
        }
      } else {
        this.#activeSessions.delete(conversationId);
      }
    }
  }

  /** M17.5 P7: Write an assistant message revision directly to the ledger.
   *  This is the SOLE authoritative entry for assistant messages in the conversation.
   *
   *  Streaming revisions: first write gets a real seq, subsequent writes for the
   *  same spanId update the row in-place (same messageId -> same seq). Done state
   *  always writes a fresh row. */
  async appendAssistantMessage(input: {
    conversationId: string;
    senderMemberId: string;
    spanId: string;
    revision: MessageRevision;
  }): Promise<number> {
    const stamped: MessageRevision = {
      ...input.revision,
      conversationId: input.conversationId,
      spanId: input.spanId,
    };
    const serialized = serializeMessageRevision(stamped);
    const ts = Date.now();
    const isStreaming = input.revision.state === "streaming";

    let seq: number;
    if (isStreaming) {
      const existing = this.#streamingSeq.get(input.spanId);
      if (existing !== undefined) {
        this.port.updateLedgerContent?.(existing, serialized, ts);
        seq = existing;
      } else {
        seq = this.port.appendLedgerEntry({
          conversationId: input.conversationId,
          senderMemberId: input.senderMemberId,
          addressedTo: [],
          kind: "message",
          content: serialized,
          ts,
          spanId: input.spanId,
        });
        this.#streamingSeq.set(input.spanId, seq);
      }
    } else {
      seq = this.port.appendLedgerEntry({
        conversationId: input.conversationId,
        senderMemberId: input.senderMemberId,
        addressedTo: [],
        kind: "message",
        content: serialized,
        ts,
        spanId: input.spanId,
      });
      this.#streamingSeq.delete(input.spanId);
    }

    this.#notify(input.conversationId, {
      seq,
      conversationId: input.conversationId,
      senderMemberId: input.senderMemberId,
      addressedTo: [],
      kind: "message" as const,
      content: serialized,
      ts,
      spanId: input.spanId,
    });
    return seq;
  }

  /** M14.4: Trigger agent runs from agent-to-agent @mentions.
   *  Only forks runs - does NOT append ledger entries (caller already did).
   *  Best-effort: silently skips if conversation busy or hop-capped. */
  async triggerMentionedAgents(input: {
    conversationId: string;
    senderMemberId: string;
    addressedTo: string[];
  }): Promise<Array<{ agentMemberId: string; spanId: string }>> {
    const triggeredRuns: Array<{ agentMemberId: string; spanId: string }> = [];
    if (input.addressedTo.length === 0) return triggeredRuns;

    const members = this.port.getMembers(input.conversationId);
    const convRow = this.port.getConversation(input.conversationId);
    if (!convRow) return triggeredRuns;

    // Build conv for resolveTriggerTargets
    const conv = this.#buildConversation(input.conversationId);
    if (!conv) return triggeredRuns;

    const targets = resolveTriggerTargets(conv, input.addressedTo);
    if (targets.length === 0) return triggeredRuns;

    // Increment hop count for agent sender
    const senderIsAgent = members.some(
      (m) => m.memberId === input.senderMemberId && m.kind === "agent",
    );
    if (senderIsAgent) {
      this.port.updateHopCount(input.conversationId, (convRow.hopCount ?? 0) + 1);
    }

    // Hop hard-cap check
    const currentHop = this.port.getConversation(input.conversationId)?.hopCount ?? 0;
    if (currentHop > this.#maxHops()) return triggeredRuns;

    // Conversation busy guard (best-effort: skip, don't throw)
    if (this.#lock.isActive(input.conversationId)) return triggeredRuns;

    // Fork runs (shared helper with postMessage)
    return this.#forkAgentRuns(input.conversationId, targets, 0);
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

    // 2. Verify run owns the old conversation
    if (this.#verifyRunOwnsConversation) {
      await this.#verifyRunOwnsConversation(requestedByRunId, oldConversationId);
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

  async clearConversation(conversationId: string): Promise<void> {
    this.#onClear?.(conversationId);
    this.#lock.releaseAll(conversationId);
    this.#activeSessions.delete(conversationId);
  }

  async compactConversation(conversationId: string): Promise<void> {
    await this.#onCompact?.(conversationId);
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

    // Copy members (preserve memberId so @mentions and session bindings carry over).
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

    // Copy live (non-undone) ledger entries up to fromSeq, preserving content/kind/ts.
    const entries = this.port
      .getLedgerEntries(input.conversationId)
      .filter((e) => e.seq <= input.fromSeq && !e.undone);
    for (const entry of entries) {
      this.port.appendLedgerEntry({
        conversationId: newId,
        senderMemberId: entry.senderMemberId,
        addressedTo: entry.addressedTo,
        kind: entry.kind,
        // getLedgerEntries parses content back to an object (zod transform); re-serialize
        // so the new row stores the same JSON string as the source.
        content: typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
        ts: entry.ts,
        spanId: entry.spanId ?? undefined,
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
    // Broadcast an undo ledger entry so subscribers grey out the messages.
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
    // Fork everything before the edited message, then post the edited message
    // which reuses postMessage's trigger logic to start agent runs.
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
