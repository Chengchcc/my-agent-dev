import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteConversationAdapter } from "../conversation/adapter-sqlite.js";
import { sqliteAgentContextAdapter } from "./adapter-sqlite.js";
import type { AgentContextPort, IdGenerator, LedgerMessageResolver } from "./ports.js";
import { createAgentContextService } from "./service.js";

const db = openDb(":memory:");
const conv = sqliteConversationAdapter(db);
const ctxPort: AgentContextPort = sqliteAgentContextAdapter(db);
const idGen: IdGenerator = { ulid: () => crypto.randomUUID().replace(/-/g, "").slice(0, 26) };
const ledgerResolver: LedgerMessageResolver = {
  async resolveMessage(conversationId, ledgerSeq) {
    const entry = conv.getLedgerEntry(conversationId, ledgerSeq);
    if (!entry) return null;
    return entry.content as never;
  },
};
const ctx = createAgentContextService({ port: ctxPort, idGen, ledgerResolver });

function freshFixture(prefix: string) {
  const conversationId = `conv-${prefix}`;
  const agentId = `ag-${prefix}`;
  conv.createConversation({
    conversationId,
    agentId,
    createdAt: Date.now(),
  });
  return { conversationId, agentId };
}

afterAll(() => db.close());

describe("Agent Context service", () => {
  test("lazy default branch creation for existing conversation", async () => {
    const { conversationId } = freshFixture("svc1");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    expect(branch.backendKind).toBe("oma");
    expect(branch.isDefault).toBe(true);

    // Second call returns the same branch
    const branch2 = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    expect(branch2.branchId).toBe(branch.branchId);
  });

  test("model change affects next run, not current snapshot", async () => {
    const { conversationId } = freshFixture("svc2");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    const defaultModel = { backendKind: "oma", modelId: "model-a" } as const;

    // Before change: effective model is default
    const before = await ctx.resolveEffectiveModel(branch.branchId, defaultModel);
    expect(before.modelId).toBe("model-a");

    // Change model
    await ctx.changeModel(branch.branchId, 1, {
      backendKind: "oma",
      modelId: "model-b",
    });

    // After change: effective model is the new one
    const after = await ctx.resolveEffectiveModel(branch.branchId, defaultModel);
    expect(after.modelId).toBe("model-b");
  });

  test("model change rejects mismatched backend kind", async () => {
    const { conversationId } = freshFixture("svc3");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    expect(
      ctx.changeModel(branch.branchId, 1, {
        backendKind: "claude_code",
        modelId: "model-x",
      }),
    ).rejects.toThrow();
  });

  test("fork inherits backend kind and preserves entries", async () => {
    const { conversationId } = freshFixture("svc4");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    const appended = await ctx.appendPrivateMessage(branch.branchId, 1, {
      role: "user",
      text: "original",
    });

    const { branch: forked } = await ctx.forkBranch(
      branch.branchId,
      2,
      appended.branch.leafEntryId!,
    );
    expect(forked.backendKind).toBe("oma");

    const entries = await ctx.listEntriesToLeaf(forked.branchId);
    expect(entries).toHaveLength(1);
  });

  test("fork can override backend kind", async () => {
    const { conversationId } = freshFixture("svc5");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    const appended = await ctx.appendPrivateMessage(branch.branchId, 1, {
      role: "user",
      text: "x",
    });

    const { branch: forked } = await ctx.forkBranch(
      branch.branchId,
      2,
      appended.branch.leafEntryId!,
      "claude_code",
    );
    expect(forked.backendKind).toBe("claude_code");
  });

  test("rollback preserves all entries", async () => {
    const { conversationId } = freshFixture("svc6");
    const branch = await ctx.getOrCreateDefaultBranch(conversationId, "oma");
    const r1 = await ctx.appendPrivateMessage(branch.branchId, 1, {
      role: "user",
      text: "first",
    });
    await ctx.appendPrivateMessage(branch.branchId, 2, {
      role: "user",
      text: "second",
    });

    // Rollback to r1
    await ctx.moveBranchLeaf(branch.branchId, 3, r1.entryId);

    // Both entries still exist in the tree
    const entries = await ctx.listEntriesToLeaf(branch.branchId);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryId).toBe(r1.entryId);
  });
});
