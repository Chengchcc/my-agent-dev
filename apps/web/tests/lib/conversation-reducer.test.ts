import { describe, expect, test } from "bun:test";
import { initialState, isBusy, reducer, type SenderRef } from "@/lib/conversation-reducer";

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
    expect(s.todos).toEqual([]);
    expect(s.optimisticSeq).toBe(0);
  });
});

describe("bootstrap", () => {
  test("populates roster and sets viewer", () => {
    const s = bootstrap();
    expect(s.roster["agent-1"]?.displayName).toBe("Bot");
    expect(s.roster["human-1"]?.displayName).toBe("User");
    expect(s.viewerMemberId).toBe("human-1");
    expect(s.triggerMode).toBe("auto"); // 1 agent → "auto"
  });

  test("mention trigger when multiple agents", () => {
    const a2: SenderRef = { memberId: "agent-2", kind: "agent", displayName: "Bot2" };
    const h: SenderRef = { memberId: "human-1", kind: "human" };
    const s = bootstrap({ members: [h, { memberId: "agent-1", kind: "agent" }, a2] });
    expect(s.triggerMode).toBe("mention");
  });
});

describe("message", () => {
  test("adds a new message", () => {
    let s = bootstrap();
    s = reducer(s, { type: "message", seq: 1, senderMemberId: "agent-1", content: rev() });
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
    s = reducer(s, { type: "message", seq: 1, senderMemberId: "agent-1", content: rev() });
    s = reducer(s, {
      type: "message",
      seq: 2,
      senderMemberId: "agent-1",
      content: rev({ state: "done", text: "final" }),
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
      senderMemberId: "human-1",
      content: { messageId: "s-1", state: "done", role: "user", updatedAt: 1, text: "hi" },
    });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]!.id).toBe("s-1");
  });
});

describe("isBusy", () => {
  test("busy while a send is in flight", () => {
    let s = bootstrap();
    s = reducer(s, { type: "send", text: "hi", viewer: { memberId: "h", kind: "human" } });
    expect(isBusy(s)).toBe(true);
  });

  test("busy while messages are queued locally", () => {
    let s = bootstrap();
    s = reducer(s, { type: "queue/add", text: "later" });
    expect(isBusy(s)).toBe(true);
  });

  test("not busy when idle (canonical done messages only)", () => {
    let s = bootstrap();
    s = reducer(s, {
      type: "message",
      seq: 1,
      senderMemberId: "agent-1",
      content: rev({ state: "done" }),
    });
    expect(isBusy(s)).toBe(false);
  });
});

describe("toggleTriggerMode", () => {
  test("toggles auto ↔ mention", () => {
    let s = bootstrap({
      members: [
        { memberId: "agent-1", kind: "agent" },
        { memberId: "agent-2", kind: "agent" },
        { memberId: "human-1", kind: "human" },
      ],
    });
    expect(s.triggerMode).toBe("mention");
    s = reducer(s, { type: "toggleTriggerMode" });
    expect(s.triggerMode).toBe("auto");
    s = reducer(s, { type: "toggleTriggerMode" });
    expect(s.triggerMode).toBe("mention");
  });
});

describe("todo/update", () => {
  test("sets todos", () => {
    let s = bootstrap();
    const todos = [{ step: "step1", status: "done" as const }];
    s = reducer(s, { type: "todo/update", todos });
    expect(s.todos).toEqual(todos);
  });

  test("clears previous todos", () => {
    let s = bootstrap();
    s = reducer(s, { type: "todo/update", todos: [{ step: "old", status: "done" }] });
    s = reducer(s, { type: "todo/update", todos: [] });
    expect(s.todos).toEqual([]);
  });
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
    if (s.items[0]!.kind === "notice") expect(s.items[0]!.text).toInclude("加入");
  });
});

describe("groupTurns", () => {
  test("groups continuous same-agent messages", () => {
    let s = bootstrap();
    // Agent messages need to have different messageIds to show separately
    s = reducer(s, {
      type: "message",
      seq: 1,
      senderMemberId: "agent-1",
      content: rev({ messageId: "m1", text: "msg1", state: "done" }),
    });
    s = reducer(s, {
      type: "message",
      seq: 2,
      senderMemberId: "agent-1",
      content: rev({ messageId: "m2", text: "msg2", state: "done" }),
    });
    expect(s.items).toHaveLength(2);
  });
});
