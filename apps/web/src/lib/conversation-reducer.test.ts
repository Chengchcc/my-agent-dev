import { describe, expect, test } from "bun:test";
import type { MessageRevision } from "@chengchenccc/message";
import {
  groupTurns,
  initialState,
  isBusy,
  isConclusionMessage,
  isTurnStart,
  type MessageItem,
  reducer,
  type SenderRef,
  type TurnSegment,
} from "@/lib/conversation-reducer";

function bootstrap() {
  const a: SenderRef = { memberId: "agent-1", kind: "agent", displayName: "Bot" };
  return reducer(initialState(), { type: "bootstrap", agent: a });
}

function rev(overrides: Partial<MessageRevision> = {}): MessageRevision {
  return {
    messageId: "run:r1:assistant:0",
    state: "streaming",
    role: "assistant",
    updatedAt: 1,
    text: "hello",
    runId: "r1",
    ...overrides,
  } as MessageRevision;
}

function msg(over: { id: string; text?: string; blocks?: unknown[] }): MessageItem {
  return {
    kind: "message",
    id: over.id,
    seq: 0,
    sender: { kind: "agent", memberId: "ag1", agentId: "ag1" },
    content: {
      id: over.id,
      role: "assistant",
      state: "done",
      text: over.text ?? "",
      blocks: (over.blocks ?? []) as MessageItem["content"]["blocks"],
    },
  } as MessageItem;
}

describe("initialState", () => {
  test("returns empty state", () => {
    const s = initialState();
    expect(s.items).toEqual([]);
    expect(s.streamConn).toBe("connecting");
    expect(s.optimisticSeq).toBe(0);
  });
});

describe("bootstrap", () => {
  test("sets the conversation agent", () => {
    const s = bootstrap();
    expect(s.agent?.displayName).toBe("Bot");
  });
});

describe("message", () => {
  test("adds a new message", () => {
    let s = bootstrap();
    s = reducer(s, { type: "message", seq: 1, message: rev() });
    expect(s.items).toHaveLength(1);
    expect(
      (s.items[0] as { content: { id: string; state: string; text?: string } }).content.id,
    ).toBe("run:r1:assistant:0");
    expect(
      (s.items[0] as { content: { id: string; state: string; text?: string } }).content.state,
    ).toBe("streaming");
  });

  test("upserts by messageId — streaming → done", () => {
    let s = bootstrap();
    s = reducer(s, { type: "message", seq: 1, message: rev() });
    s = reducer(s, {
      type: "message",
      seq: 2,
      message: rev({ state: "done", text: "final" }),
    });
    expect(s.items).toHaveLength(1);
    expect(
      (s.items[0] as { content: { id: string; state: string; text?: string } }).content.state,
    ).toBe("done");
    expect(
      (s.items[0] as { content: { id: string; state: string; text?: string } }).content.text,
    ).toBe("final");
  });

  test("replaces optimistic self message", () => {
    let s = bootstrap();
    s = reducer(s, { type: "send", text: "hi", viewer: { memberId: "user", kind: "human" } });
    expect(s.items[0]!.id).toStartWith("opt-");
    s = reducer(s, {
      type: "message",
      seq: 1,
      message: { messageId: "s-1", state: "done", role: "user", updatedAt: 1, text: "hi" },
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.id).toBe("s-1");
  });

  test("system role renders as a notice, not a bubble", () => {
    let s = bootstrap();
    s = reducer(s, {
      type: "message",
      seq: 3,
      message: {
        messageId: "sys-1",
        state: "done",
        role: "system",
        updatedAt: 1,
        text: "[system] hop cap reached",
      },
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.kind).toBe("notice");
    if (s.items[0]!.kind === "notice") {
      expect(s.items[0]!.text).toInclude("hop cap");
    }
  });
});

describe("isBusy", () => {
  test("busy while a send is in flight", () => {
    let s = bootstrap();
    s = reducer(s, { type: "send", text: "hi", viewer: { memberId: "h", kind: "human" } });
    expect(isBusy(s)).toBe(true);
  });

  test("not busy when idle (canonical done messages only)", () => {
    let s = bootstrap();
    s = reducer(s, {
      type: "message",
      seq: 1,
      message: rev({ state: "done" }),
    });
    expect(isBusy(s)).toBe(false);
  });
});

// toggleTriggerMode was removed with the auto/mention toggle (b401777f);
// triggerMode is no longer part of the reducer state.

describe("todo/update", () => {
  // todo/update was removed with the Conversation-ledger todo path; todos
  // are Run-local transients delivered over the Run SSE (see transient
  // reducer tests).
});

describe("groupTurns", () => {
  test("groups continuous same-agent messages", () => {
    let s = bootstrap();
    // Agent messages need to have different messageIds to show separately
    s = reducer(s, {
      type: "message",
      seq: 1,
      message: rev({ messageId: "m1", text: "msg1", state: "done" }),
    });
    s = reducer(s, {
      type: "message",
      seq: 2,
      message: rev({ messageId: "m2", text: "msg2", state: "done" }),
    });
    expect(s.items).toHaveLength(2);
  });
});

describe("isTurnStart", () => {
  const human = {
    kind: "single" as const,
    item: {
      kind: "message" as const,
      id: "h1",
      sender: { kind: "human" as const, memberId: "u" },
      seq: 1,
      content: { text: "hi", blocks: [] } as never,
    },
  } as unknown as Extract<TurnSegment, { kind: "single" }>;
  const agent = {
    kind: "single" as const,
    item: {
      kind: "message" as const,
      id: "a1",
      sender: { kind: "agent" as const, memberId: "ag" },
      seq: 2,
      content: { text: "yo", blocks: [] } as never,
    },
  } as unknown as Extract<TurnSegment, { kind: "single" }>;
  const notice = { kind: "notice" as const, id: "n1", text: "joined" };

  test("member-joined notices never start turns (1 anchor in human-led chat)", () => {
    // notices + user + assistant → only the user message starts a turn
    const segments = [notice, notice, human, agent];
    expect(isTurnStart(segments, 0)).toBe(false);
    expect(isTurnStart(segments, 1)).toBe(false);
    expect(isTurnStart(segments, 2)).toBe(true);
    expect(isTurnStart(segments, 3)).toBe(false);
  });

  test("pure agent conversations still use sender-change fallback", () => {
    const a2 = {
      ...agent,
      item: { ...agent.item, id: "a2", sender: { ...agent.item.sender, memberId: "ag2" } },
    };
    const segments = [agent, a2];
    expect(isTurnStart(segments, 0)).toBe(true);
    expect(isTurnStart(segments, 1)).toBe(true);
  });
});

describe("groupTurns with canonical tool messages (ADR 0017)", () => {
  const agentSender: SenderRef = { memberId: "agent-1", kind: "agent", displayName: "Bot" };
  const toolUseMsg = {
    kind: "message" as const,
    id: "m-tu",
    sender: agentSender,
    seq: 2,
    content: {
      messageId: "run:r1:assistant:1",
      role: "assistant" as const,
      text: "",
      blocks: [{ type: "tool_use" as const, id: "t1", name: "read", input: {} }],
      state: "done" as const,
      updatedAt: 1,
    },
  };
  const toolMsg = {
    kind: "message" as const,
    id: "m-tr",
    sender: agentSender,
    seq: 3,
    content: {
      messageId: "run:r1:tool:1",
      role: "tool" as const,
      text: "{}",
      blocks: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }],
      state: "done" as const,
      updatedAt: 1,
    },
  };
  const finalMsg = {
    kind: "message" as const,
    id: "m-final",
    sender: agentSender,
    seq: 4,
    content: {
      messageId: "run:r1:assistant:0",
      role: "assistant" as const,
      text: "done",
      state: "done" as const,
      updatedAt: 1,
    },
  };

  test("tool result message is never a conclusion", () => {
    expect(isConclusionMessage(toolMsg)).toBe(false);
    expect(isConclusionMessage(toolUseMsg)).toBe(false);
    expect(isConclusionMessage(finalMsg)).toBe(true);
  });

  test("agent turn groups tool messages into rounds, text into conclusion", () => {
    const segments = groupTurns([toolUseMsg, toolMsg, finalMsg]);
    expect(segments).toHaveLength(1);
    const turn = segments[0]!;
    expect(turn.kind).toBe("turn");
    if (turn.kind === "turn") {
      expect(turn.rounds.map((r) => r.content.role)).toEqual(["assistant", "tool"]);
      expect(turn.rounds[1]?.content.blocks?.[0]?.type).toBe("tool_result");
      expect(turn.conclusion?.id).toBe("m-final");
    }
  });

  test("human + agent sequence keeps tool messages in the same turn", () => {
    const human: SenderRef = { memberId: "human-1", kind: "human" };
    const userMsg = {
      kind: "message" as const,
      id: "m-user",
      sender: human,
      seq: 1,
      content: {
        messageId: "u1",
        role: "user" as const,
        text: "hi",
        state: "done" as const,
        updatedAt: 1,
      },
    };
    const segments = groupTurns([userMsg, toolUseMsg, toolMsg, finalMsg]);
    expect(segments.map((s) => s.kind)).toEqual(["single", "turn"]);
  });
});

describe("groupTurns edge cases (from prior src test)", () => {
  test("empty-thinking assistant message is NOT a conclusion", () => {
    const m = msg({ id: "skeleton", blocks: [{ type: "thinking", text: "…" }] });
    expect(isConclusionMessage(m)).toBe(false);
  });

  test("tool_use round is NOT a conclusion", () => {
    const m = msg({
      id: "tool",
      blocks: [{ type: "thinking" }, { type: "tool_use", name: "bash" }],
    });
    expect(isConclusionMessage(m)).toBe(false);
  });

  test("tool_use with narrative text is still a working round", () => {
    const m = msg({
      id: "t1",
      text: "let me check",
      blocks: [
        { type: "thinking" },
        { type: "text", text: "let me check" },
        { type: "tool_use", name: "bash" },
      ],
    });
    expect(isConclusionMessage(m)).toBe(false);
  });

  test("text-bearing assistant message IS a conclusion", () => {
    const m = msg({ id: "answer", text: "done", blocks: [{ type: "thinking" }] });
    expect(isConclusionMessage(m)).toBe(true);
  });

  test("turn keeps text-bearing tool rounds in rounds (not the conclusion)", () => {
    const turn = groupTurns([
      msg({
        id: "t1",
        text: "checking",
        blocks: [{ type: "thinking" }, { type: "tool_use", name: "bash" }],
      }),
      msg({ id: "final", text: "the answer" }),
    ]);
    expect(turn).toHaveLength(1);
    const seg = turn[0]!;
    if (seg.kind === "turn") {
      expect(seg.rounds.map((r) => r.id)).toEqual(["t1"]);
      expect(seg.conclusion?.id).toBe("final");
    }
  });

  test("turn groups tool skeletons as rounds and the text answer as conclusion", () => {
    const turn = groupTurns([
      msg({ id: "u", text: "do it", blocks: [] }) as unknown as never,
      msg({ id: "t1", blocks: [{ type: "thinking" }, { type: "tool_use", name: "bash" }] }),
      msg({ id: "t2", blocks: [{ type: "thinking" }, { type: "tool_use", name: "read" }] }),
      msg({ id: "final", text: "the answer" }),
    ]);
    expect(turn).toHaveLength(1);
    const seg = turn[0]!;
    expect(seg.kind).toBe("turn");
    if (seg.kind === "turn") {
      expect(seg.rounds.map((r) => r.id)).toEqual(["u", "t1", "t2"]);
      expect(seg.conclusion?.id).toBe("final");
    }
  });
});

describe("reducer boundary actions", () => {
  test("undo marks only matching seqs as undone", () => {
    let s = bootstrap();
    s = reducer(s, { type: "message", seq: 1, message: rev({ messageId: "m1", state: "done" }) });
    s = reducer(s, { type: "message", seq: 2, message: rev({ messageId: "m2", state: "done" }) });
    s = reducer(s, { type: "undo", undoneSeqs: [1] });
    const messages = s.items.filter((item): item is MessageItem => item.kind === "message");
    const bySeq = new Map(messages.map((item) => [item.seq, item]));
    expect(bySeq.get(1)?.undone).toBe(true);
    expect(bySeq.get(2)?.undone).toBeUndefined();
  });

  test("send/settled decrements but never below zero", () => {
    let s = bootstrap();
    s = reducer(s, { type: "send", text: "hi", viewer: { memberId: "u", kind: "human" } });
    expect(s.pendingSendCount).toBe(1);
    s = reducer(s, { type: "send/settled" });
    expect(s.pendingSendCount).toBe(0);
    s = reducer(s, { type: "send/settled" });
    expect(s.pendingSendCount).toBe(0);
  });

  test("send/error stores the error message", () => {
    let s = bootstrap();
    s = reducer(s, { type: "send/error", message: "network down" });
    expect(s.error).toBe("network down");
  });
});
