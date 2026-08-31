import type { Message, MessageRevision } from "@chengchenccc/message";
import { extractText, mergeMessageRevision } from "@chengchenccc/message";

// ─── Types ────────────────────────────────────────────────

/** Mirrors the backend Member payload (cut-2 will collapse this to agent info).
 *  System notices (member join/leave) are NOT messages — they are UiItems of kind "notice". */
export interface SenderRef {
  memberId: string;
  kind: "agent" | "human";
  displayName?: string;
  /** Agent identifier — present for agent members, used for per-agent coloring. */
  agentId?: string;
}

export type UiItem =
  | {
      kind: "message";
      id: string;
      sender: SenderRef;
      content: Message;
      /** Ledger seq - needed for fork/undo/replay targeting. */
      seq: number;
      /** Soft-delete flag - greyed out when true. */
      undone?: boolean;
    }
  | { kind: "notice"; id: string; text: string };

/** "message" variant of UiItem — derived, not a new domain concept. */
export type MessageItem = Extract<UiItem, { kind: "message" }>;

export type StreamConn = "connecting" | "open" | "reconnecting" | "closed";

export interface ConvState {
  /** The conversation's agent (1:1 collapse; the human is the viewer). */
  agent: SenderRef | null;
  items: UiItem[];
  streamConn: StreamConn;
  error: string | null;
  /** Number of sends that have been dispatched locally but not yet settled
   *  by the backend (HTTP POST in-flight). Decremented on mutation
   *  onSettled (success OR error) - never tied to an agent reply; Run
   *  activity is tracked separately in the hook's activeRuns set. */
  pendingSendCount: number;
  /** W7: Monotonic sequence number for client-generated message IDs. */
  optimisticSeq: number;
}

export type Action =
  | { type: "bootstrap"; agent: SenderRef }
  | { type: "send"; text: string; viewer: SenderRef }
  /** POST settled (success OR error): decrement the in-flight counter. */
  | { type: "send/settled" }
  | { type: "conn"; status: StreamConn }
  | { type: "send/error"; message: string }
  | { type: "member"; seq: number; kind: string; payload: unknown }
  | {
      /** Wire ConversationEvent message (zod-validated at the SSE boundary).
       *  role is the authorship discriminator: user → viewer side,
       *  assistant/tool → agent side, system → notice item. */
      type: "message";
      seq: number;
      message: MessageRevision;
      /** Soft-delete flag from ledger entry (absent = live). */
      undone?: boolean;
    }
  | { type: "undo"; undoneSeqs: number[] };

export function initialState(): ConvState {
  return {
    agent: null,
    items: [],
    streamConn: "connecting",
    error: null,
    pendingSendCount: 0,
    optimisticSeq: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────

/** Whether there is an open (not done/error) assistant message
 *  that means the UI should show a busy state. */
/** Busy = a send is in flight or messages are queued locally. Execution
 *  state itself comes from Agent Runs (active run set in the hook layer). */
/** Busy = a send is in flight. Execution state itself comes from Agent
 *  Runs (active run set in the hook layer). */
export function isBusy(s: ConvState): boolean {
  return s.pendingSendCount > 0;
}

/** Role → sender. role is the authorship discriminator on the wire:
 *  user → the viewer (human); assistant/tool → the conversation's agent;
 *  (system never reaches here — the reducer turns it into a notice). */
function senderForRole(role: MessageRevision["role"], s: ConvState): SenderRef {
  if (role === "user") return { memberId: "user", kind: "human" };
  return s.agent ?? { memberId: "agent", kind: "agent" };
}

function upsertAuthoritative(
  list: UiItem[],
  id: string,
  sender: SenderRef,
  content: Message,
  seq: number,
  undone?: boolean,
): UiItem[] {
  const idx = list.findIndex((item) => item.kind === "message" && item.id === id);
  if (idx >= 0) {
    const next = [...list];
    const prev = next[idx]!;
    next[idx] = {
      kind: "message",
      id,
      sender,
      content,
      seq,
      undone: undone ?? (prev.kind === "message" ? prev.undone : undefined),
    };
    return next;
  }
  // Self echo: replace the latest optimistic self message (user role)
  if (sender.kind === "human") {
    const optIdx = [...list]
      .reverse()
      .findIndex((item) => item.kind === "message" && item.id.startsWith("opt-"));
    if (optIdx >= 0) {
      const real = list.length - 1 - optIdx;
      const next = [...list];
      next[real] = { kind: "message", id, sender, content, seq, undone };
      return next;
    }
  }
  return [...list, { kind: "message", id, sender, content, seq, undone }];
}

// ─── Turn Grouping (pure render-layer) ─────────────────────

export type TurnSegment =
  | { kind: "single"; item: MessageItem }
  | { kind: "notice"; text: string; id: string }
  | {
      kind: "turn";
      id: string;
      sender: SenderRef;
      rounds: MessageItem[];
      conclusion: MessageItem | null;
    };

export function isConclusionMessage(m: MessageItem): boolean {
  // Tool results are working rounds, never conclusions (ADR 0017): the
  // canonical ledger keeps them as separate `tool` messages carrying a
  // JSON text payload — without this guard they'd be classified as a
  // final conclusion and rendered as a bubble.
  if (m.content.role === "tool") return false;
  const blocks = m.content.blocks;
  // A round that issued a tool call is a working round, not the conclusion —
  // even when the model interleaved narrative text with the tool_use.
  const hasToolUse = blocks?.some((b: { type: string }) => b.type === "tool_use") ?? false;
  if (hasToolUse) return false;
  const text = extractText({ text: m.content.text, blocks });
  if (text.trim().length > 0) return true;
  if (!blocks || blocks.length === 0) return false;
  // A pure thinking-only skeleton (empty text, no tool_use) is a tool-round
  // scaffold, not a conclusion — claiming the conclusion slot inflates the
  // headline count by one and hides the real final answer.
  return blocks.some((b: { type: string }) => b.type !== "thinking");
}

export function groupTurns(items: UiItem[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === "notice") {
      out.push({ kind: "notice", text: item.text, id: item.id });
      i++;
      continue;
    }
    if (item.sender.kind !== "agent") {
      out.push({ kind: "single", item });
      i++;
      continue;
    }
    const start = i;
    while (i < items.length) {
      // i < items.length guarantees items[i] is defined
      const cur = items[i]!;
      if (
        cur.kind !== "message" ||
        cur.sender.kind !== "agent" ||
        cur.sender.memberId !== item.sender.memberId
      )
        break;
      i++;
    }
    const block = items.slice(start, i).filter((x): x is MessageItem => x.kind === "message");
    let lastConclusionIdx = -1;
    for (let k = block.length - 1; k >= 0; k--) {
      if (isConclusionMessage(block[k]!)) {
        lastConclusionIdx = k;
        break;
      }
    }
    const conclusion = lastConclusionIdx >= 0 ? block[lastConclusionIdx]! : null;
    const rounds = block.filter((_, k) => k !== lastConclusionIdx);
    out.push({ kind: "turn", id: block[0]!.id, sender: item.sender, rounds, conclusion });
  }
  return out;
}

/** Whether segment `i` starts a new turn. System notices never start turns;
 *  in human-led conversations only human messages do. The sender-change
 *  fallback applies ONLY to pure agent conversations (no human segment),
 *  so member-joined notices can't fabricate turn numbers. */
export function isTurnStart(segments: TurnSegment[], i: number): boolean {
  const seg = segments[i]!;
  if (seg.kind === "notice") return false;
  const sender = segmentSenderOf(seg);
  if (sender.kind === "human") return true;
  const hasHuman = segments.some((s) => s.kind !== "notice" && segmentSenderOf(s).kind === "human");
  if (hasHuman) return false;
  if (i === 0) return true;
  const prevSender = segmentSenderOf(segments[i - 1]!);
  return prevSender.memberId !== sender.memberId;
}

function segmentSenderOf(seg: TurnSegment): SenderRef {
  if (seg.kind === "turn") return seg.sender;
  if (seg.kind === "single") return seg.item.sender;
  return { kind: "agent", memberId: "" }; // notice (never queried: filtered above)
}

// ─── Reducer ───────────────────────────────────────────────

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "bootstrap": {
      return { ...s, agent: a.agent };
    }
    case "message": {
      const revision = a.message;
      // System authorship renders as a notice, not a chat bubble.
      if (revision.role === "system") {
        const text = extractText({ text: revision.text, blocks: revision.blocks });
        return {
          ...s,
          items: [...s.items, { kind: "notice", id: revision.messageId, text: text || "[system]" }],
        };
      }
      const existing = s.items.find(
        (it): it is Extract<UiItem, { kind: "message" }> =>
          it.kind === "message" && it.id === revision.messageId,
      );
      const message = mergeMessageRevision(existing?.content ?? null, revision);
      const id = message.id ?? revision.messageId;
      const sender = senderForRole(revision.role, s);
      const items = upsertAuthoritative(s.items, id, sender, message, a.seq, a.undone);
      // pendingSendCount tracks ONLY the HTTP POST in flight (see
      // send/settled); an agent reply must not fake-clear it.
      return { ...s, items };
    }

    case "undo": {
      // Soft-delete: mark messages with seq in undoneSeqs as undone (greyed out).
      const undoSet = new Set(a.undoneSeqs);
      const items = s.items.map((item) =>
        item.kind === "message" && undoSet.has(item.seq) ? { ...item, undone: true } : item,
      );
      return { ...s, items };
    }
    case "send": {
      // W7: use stable UUID instead of opt- prefix — enables precise matching
      // when backend echoes the message back (future: clientMsgId in API).
      const id = `opt-${crypto.randomUUID()}`;
      return {
        ...s,
        pendingSendCount: s.pendingSendCount + 1,
        items: [
          ...s.items,
          {
            kind: "message" as const,
            id,
            sender: a.viewer,
            content: { id, role: "user" as const, state: "done" as const, text: a.text },
            seq: -1, // ponytail: sentinel - replaced when backend echoes authoritative seq
          },
        ],
      };
    }

    case "conn":
      return { ...s, streamConn: a.status };

    case "send/settled":
      return {
        ...s,
        pendingSendCount: Math.max(0, s.pendingSendCount - 1),
      };

    case "send/error":
      return {
        ...s,
        error: a.message,
      };

    default:
      return s;
  }
}
