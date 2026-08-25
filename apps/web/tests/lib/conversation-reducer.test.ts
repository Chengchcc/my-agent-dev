import { describe, expect, test } from "bun:test";
import {
  groupTurns,
  initialState,
  isBusy,
  isConclusionMessage,
  isTurnStart,
  reducer,
  type SenderRef,
} from "@/lib/conversation-reducer";

function bootstrap(overrides: { viewerMemberId?: string; members?: SenderRef[] } = {}) {
  const a: SenderRef = { memberId: "agent-1", kind: "agent", displayName: "Bot" };
  const h: SenderRef = { memberId: "human-1", kind: "human", displayName: "User" };
  return reducer(initialState(), {
    type: "bootstrap",
    viewerMemberId: overrides.viewerMemberId ?? h.memberId,
    members: overrides.members ?? [a, h],
  });
}

function rev(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "run:r1:assistant:0",
    state: "streaming",
    role: "assistant",
    updatedAt: 1,
    text: "hello",
    runId: "r1",
    ...overrides,
  };
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
  test("populates roster and sets viewer", () => {
    const s = bootstrap();
    expect(s.roster["agent-1"]?.displayName).toBe("Bot");
    expect(s.roster["human-1"]?.displayName).toBe("User");
    expect(s.viewerMemberId).toBe("human-1");
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
    s = reducer(s, { type: "send", text: "hi", viewer: s.roster["human-1"]! });
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

describe("member", () => {
  test("adds system notice for member join", () => {
    let s = bootstrap();
    s = reducer(s, {
      type: "member",
      seq: 10,
      kind: "member.joined",
      payload: { members: [{ memberId: "human-2", kind: "human", displayName: "User2" }] },
    });
    expect(s.roster["human-2"]?.displayName).toBe("User2");
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.kind).toBe("notice");
    if (s.items[0]!.kind === "notice") expect(s.items[0]!.text).toInclude("joined");
  });
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
      id: "h1",
      sender: { kind: "human" as const, memberId: "u" },
      seq: 1,
      content: { text: "hi", blocks: [] },
    },
  };
  const agent = {
    kind: "single" as const,
    item: {
      id: "a1",
      sender: { kind: "agent" as const, memberId: "ag" },
      seq: 2,
      content: { text: "yo", blocks: [] },
    },
  };
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
