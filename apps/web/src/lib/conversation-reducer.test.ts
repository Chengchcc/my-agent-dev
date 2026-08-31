import { describe, expect, test } from "bun:test";
import { groupTurns, isConclusionMessage, type MessageItem } from "./conversation-reducer";

function msg(over: Partial<MessageItem["content"]> & { id: string }): MessageItem {
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
      blocks: over.blocks ?? [],
    },
  } as MessageItem;
}

describe("conversation-reducer turn grouping", () => {
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
      // Both tool skeletons stay as rounds (rendered in the trace);
      // the text answer becomes the only conclusion.
      expect(seg.rounds.map((r) => r.id)).toEqual(["u", "t1", "t2"]);
      expect(seg.conclusion?.id).toBe("final");
    }
  });
});
