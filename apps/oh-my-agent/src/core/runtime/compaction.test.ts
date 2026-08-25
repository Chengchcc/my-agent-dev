import { describe, expect, test } from "bun:test";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { compactSession } from "./compaction.js";

async function setup(messages: Array<Record<string, unknown>>) {
  const store = createInMemorySessionStore();
  const sid = `compaction-${Math.random().toString(36).slice(2, 8)}`;
  await store.create({
    sessionId: sid,
    backendKind: "oma",
    workspaceRoot: "/ws",
    leafEntryId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.appendBatch(sid, { entries: messages });
  return { store, sid };
}

describe("compactSession", () => {
  test("cut does not split assistant tool_use from its tool_result", async () => {
    // 5 messages; raw 60% cut = 3, which would cover [m1, m2, assistant(tool_use)]
    // and leave an orphan tool_result.
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "assistant",
        source: "assistant",
        message: {
          role: "assistant",
          text: "",
          blocks: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
        },
        createdAt: 3,
      },
      {
        type: "message",
        role: "tool",
        source: "tool_result",
        message: {
          role: "tool",
          text: "{}",
          blocks: [{ type: "tool_result", tool_use_id: "tc-1", content: "{}" }],
        },
        createdAt: 4,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "tail" },
        createdAt: 5,
      },
    ]);

    const result = await compactSession(store, sid, async (texts) => `[sum:${texts.length}]`);

    // Cut must have moved before the assistant: only m1+m2 covered
    expect(result.coveredIds).toHaveLength(2);
    const branch = await store.readBranch(sid);
    const uncovered = branch.filter((e) => !result.coveredIds.includes(e.entryId));
    const sources = uncovered.map((e) => (e as { source?: string }).source);
    // assistant tool_use and tool_result both survive
    expect(sources).toContain("assistant");
    expect(sources).toContain("tool_result");
    expect(sources).toContain("prompt"); // tail
  });

  test("cut can cover a complete tool pair when the boundary is after it", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "assistant",
        source: "assistant",
        message: {
          role: "assistant",
          text: "",
          blocks: [{ type: "tool_use", id: "tc-1", name: "echo", input: {} }],
        },
        createdAt: 2,
      },
      {
        type: "message",
        role: "tool",
        source: "tool_result",
        message: {
          role: "tool",
          text: "{}",
          blocks: [{ type: "tool_result", tool_use_id: "tc-1", content: "{}" }],
        },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 4,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 5,
      },
    ]);

    const result = await compactSession(store, sid, async (texts) => `[sum:${texts.length}]`);
    // Raw cut 3 lands exactly after the tool_result; no adjustment needed
    expect(result.coveredIds).toHaveLength(3);
  });

  test("under budget is a no-op: no summarizer call, no entry", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    let summarizerCalls = 0;
    const budget = {
      estimate: () => 1, // 4 messages * 1 = 4 tokens
      limit: 10, // under limit -> no compaction
    };
    const result = await compactSession(
      store,
      sid,
      async () => {
        summarizerCalls++;
        return "sum";
      },
      undefined,
      budget,
    );
    expect(summarizerCalls).toBe(0);
    expect(result.coveredIds).toHaveLength(0);
    const branch = await store.readBranch(sid);
    expect(branch.some((e) => e.type === "compaction")).toBe(false);
  });

  test("over budget cuts by tokens and records diagnostics", async () => {
    const { store, sid } = await setup([
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m1" },
        createdAt: 1,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m2" },
        createdAt: 2,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m3" },
        createdAt: 3,
      },
      {
        type: "message",
        role: "user",
        source: "prompt",
        message: { role: "user", text: "m4" },
        createdAt: 4,
      },
    ]);
    const budget = {
      estimate: () => 3, // 4 messages * 3 = 12 tokens
      limit: 9, // over limit -> compact until retained <= 9
    };
    const result = await compactSession(
      store,
      sid,
      async (msgs) => `[sum:${msgs.length}]`,
      undefined,
      budget,
    );
    // Cover oldest until remaining <= 9: cover 1 msg (12-3=9 <= 9)
    expect(result.coveredIds).toHaveLength(1);
    const branch = await store.readBranch(sid);
    const comp = branch.find((e) => e.type === "compaction") as {
      tokensBefore?: number;
      retainedEntryIds?: readonly string[];
    };
    expect(comp).toBeTruthy();
    expect(comp.tokensBefore).toBe(12);
    expect(comp.retainedEntryIds?.length).toBe(3);
  });
});
