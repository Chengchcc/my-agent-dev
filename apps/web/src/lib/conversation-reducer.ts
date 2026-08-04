import type { Message, MessageRevision } from "@my-agent-team/message";
import { extractText, mergeMessageRevision, parseMessageRevision } from "@my-agent-team/message";

// ─── Types ────────────────────────────────────────────────

/** Mirrors @my-agent-team/conversation Member.kind exactly.
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
      /** Original addressedTo - needed for replay. */
      addressedTo: string[];
      /** Soft-delete flag - greyed out when true. */
      undone?: boolean;
    }
  | { kind: "notice"; id: string; text: string };

/** "message" variant of UiItem — derived, not a new domain concept. */
export type MessageItem = Extract<UiItem, { kind: "message" }>;

export type TriggerMode = "auto" | "mention";
export type StreamConn = "connecting" | "open" | "reconnecting" | "closed";

export interface ConvState {
  viewerMemberId: string;
  roster: Record<string, SenderRef>;
  items: UiItem[];
  streamConn: StreamConn;
  error: string | null;
  triggerMode: TriggerMode;
  /** M14.6: Task todo progress — full snapshot from todo_update events. */
  todos: Array<{ step: string; status: "pending" | "in_progress" | "done" }>;
  /** Number of sends that have been dispatched locally but not yet
   *  confirmed by the backend (POST in-flight). Cleared when the first
   *  authoritative agent revision arrives or on send error. */
  pendingSendCount: number;
  /** W7: Monotonic sequence number for client-generated message IDs. */
  optimisticSeq: number;
}

export type Action =
  | { type: "bootstrap"; viewerMemberId: string; members: SenderRef[] }
  | { type: "send"; text: string; viewer: SenderRef }
  | { type: "conn"; status: StreamConn }
  | { type: "toggleTriggerMode" }
  | { type: "send/error"; message: string }
  | { type: "todo/update"; todos: ConvState["todos"] }
  | { type: "member"; seq: number; kind: string; payload: unknown }
  | {
      type: "message";
      seq: number;
      senderMemberId: string;
      addressedTo: string[];
      content: unknown;
      /** Soft-delete flag from ledger entry (absent = live). */
      undone?: boolean;
    }
  | { type: "undo"; undoneSeqs: number[] };

export function initialState(): ConvState {
  return {
    viewerMemberId: "",
    roster: {},
    items: [],
    streamConn: "connecting",
    error: null,
    triggerMode: "auto",
    todos: [],
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

function upsertAuthoritative(
  list: UiItem[],
  id: string,
  sender: SenderRef,
  content: Message,
  viewerMemberId: string,
  seq: number,
  addressedTo: string[],
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
      addressedTo,
      undone: undone ?? (prev.kind === "message" ? prev.undone : undefined),
    };
    return next;
  }
  // Self echo: replace optimistic self message
  if (sender.memberId === viewerMemberId) {
    const optIdx = [...list]
      .reverse()
      .findIndex(
        (item) =>
          item.kind === "message" &&
          item.id.startsWith("opt-") &&
          item.sender.memberId === viewerMemberId,
      );
    if (optIdx >= 0) {
      const real = list.length - 1 - optIdx;
      const next = [...list];
      next[real] = { kind: "message", id, sender, content, seq, addressedTo, undone };
      return next;
    }
  }
  return [...list, { kind: "message", id, sender, content, seq, addressedTo, undone }];
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
  const text = extractText({ text: m.content.text, blocks: m.content.blocks });
  if (text.trim().length > 0) return true;
  const blocks = m.content.blocks;
  if (!blocks || blocks.length === 0) return false;
  const hasToolUse = blocks.some((b: { type: string }) => b.type === "tool_use");
  return !hasToolUse;
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

// ─── Reducer ───────────────────────────────────────────────

export function reducer(s: ConvState, a: Action): ConvState {
  switch (a.type) {
    case "bootstrap": {
      const roster: Record<string, SenderRef> = {};
      for (const m of a.members) roster[m.memberId] = m;
      const agentCount = Object.values(roster).filter((m) => m.kind === "agent").length;
      return {
        ...s,
        viewerMemberId: a.viewerMemberId,
        roster,
        triggerMode: agentCount > 1 ? "mention" : "auto",
      };
    }
    case "member": {
      const payload = a.payload as {
        members?: Array<{
          memberId: string;
          kind: "agent" | "human";
          displayName?: string;
          agentId?: string;
        }>;
      };
      const roster = { ...s.roster };
      for (const m of payload.members ?? []) roster[m.memberId] = { ...m };
      const verb = a.kind === "member.joined" ? "加入" : "离开";
      const present = (payload.members ?? [])
        .map((m) => roster[m.memberId]?.displayName ?? m.memberId)
        .join(", ");
      const id = `notice-${a.seq}`;
      const items: UiItem[] = [
        ...s.items,
        { kind: "notice", id, text: `[系统] 成员变化：${verb}。当前在场：${present}` },
      ];
      return { ...s, roster, items };
    }

    case "message": {
      let revision: MessageRevision;
      try {
        revision = parseMessageRevision(a.content);
      } catch (err) {
        console.error(
          `[reducer] invalid message revision at seq=${a.seq}, skipping:`,
          err instanceof Error ? err.message : String(err),
        );
        return s;
      }
      const existing = s.items.find(
        (it): it is Extract<UiItem, { kind: "message" }> =>
          it.kind === "message" && it.id === revision.messageId,
      );
      const message = mergeMessageRevision(existing?.content ?? null, revision);
      const id = message.id ?? "";
      const sender = s.roster[a.senderMemberId] ?? {
        memberId: a.senderMemberId,
        kind: "agent" as const,
      };
      const items = upsertAuthoritative(
        s.items,
        id,
        sender,
        message,
        s.viewerMemberId,
        a.seq,
        a.addressedTo ?? [],
        a.undone,
      );
      const cleared = sender.kind === "agent" && s.pendingSendCount > 0 ? 0 : s.pendingSendCount;
      return { ...s, items, pendingSendCount: cleared };
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
            addressedTo: [],
          },
        ],
      };
    }

    case "conn":
      return { ...s, streamConn: a.status };

    case "send/error":
      return {
        ...s,
        error: a.message,
        pendingSendCount: Math.max(0, s.pendingSendCount - 1),
      };

    case "toggleTriggerMode":
      return { ...s, triggerMode: s.triggerMode === "auto" ? "mention" : "auto" };

    case "todo/update":
      return { ...s, todos: a.todos };

    default:
      return s;
  }
}
