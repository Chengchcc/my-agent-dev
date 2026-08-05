import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendRunInput, BackendRunSegment } from "@my-agent-team/agent-backend";
import type { Model, Provider } from "@my-agent-team/ai";
import { createModelRuntime } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import { createCodingAgentRuntime } from "./create-runtime.js";

const tmp = `/tmp/runtime-test-${Math.random().toString(36).slice(2, 8)}`;
mkdirSync(tmp, { recursive: true });

const FAKE_MODEL: Model = {
  id: "echo",
  name: "Fake Echo",
  provider: "fake",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

/** Recording provider: captures every model input batch for assertions. */
function recordingProvider(record: Message[][]): Provider {
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      record.push([...messages]);
      yield { delta: { type: "text", text: "done" } };
      yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  };
}

function makeModelRuntime(record: Message[][]) {
  const runtime = createModelRuntime();
  runtime.registerProvider(recordingProvider(record));
  return runtime;
}

function runInput(runId: string, systemPrompt?: string): BackendRunInput<"coding_agent"> {
  return {
    history: [],
    input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
    run: {
      runId,
      model: { backendKind: "coding_agent", modelId: "fake/echo" },
      ...(systemPrompt ? { systemPrompt } : {}),
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentMemberId: "m", branchId: "b" },
  };
}

async function settle(segment: BackendRunSegment<"coding_agent">) {
  const outcome = await segment.outcome;
  const events: string[] = [];
  const collect = (async () => {
    for await (const ev of segment.events) events.push(ev.type);
  })();
  await collect;
  return { outcome, events };
}

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createCodingAgentRuntime", () => {
  test("one runtime = one run: a second run() is rejected", async () => {
    const record: Message[][] = [];
    const runtime = await createCodingAgentRuntime({
      runId: "r-1",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [],
    });
    const first = await runtime.run(runInput("r-1"));
    await first.outcome;
    await expect(runtime.run(runInput("r-1"))).rejects.toThrow(/already ran/);
    await runtime.close();
  });

  test("the frozen systemPrompt enters the model input as the system message", async () => {
    const record: Message[][] = [];
    const runtime = await createCodingAgentRuntime({
      runId: "r-sp",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [],
    });
    const segment = await runtime.run(
      runInput("r-sp", "Soul content here\n\nUser context:\nuser here"),
    );
    const { outcome } = await settle(segment);
    expect(outcome.status).toBe("completed");
    expect(record.length).toBeGreaterThan(0);
    const modelMessages = record[0]!;
    expect(modelMessages[0]).toEqual({
      role: "system",
      text: "Soul content here\n\nUser context:\nuser here",
    });
    // The driving input follows the meta message.
    expect(modelMessages.some((m) => m.role === "user" && m.text === "go")).toBe(true);
    await runtime.close();
  });

  test("skillRoots are actually loaded into the Runtime (skills visible in the Meta)", async () => {
    const skillsRoot = join(tmp, "skills");
    mkdirSync(join(skillsRoot, "test-skill"), { recursive: true });
    writeFileSync(
      join(skillsRoot, "test-skill", "SKILL.md"),
      "---\nname: test-skill\ndescription: A test skill\n---\n\nBody",
    );
    const record: Message[][] = [];
    const runtime = await createCodingAgentRuntime({
      runId: "r-sk",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [skillsRoot],
    });
    const segment = await runtime.run(runInput("r-sk"));
    const { outcome } = await settle(segment);
    expect(outcome.status).toBe("completed");
    expect(record.length).toBeGreaterThan(0);
    const meta = record[0]!.find((m) => m.role === "user" && m.text?.includes("test-skill"));
    expect(meta).toBeDefined();
    expect(meta!.text).toContain("**test-skill**");
    await runtime.close();
  });

  test("steer injects into the live loop", async () => {
    const record: Message[][] = [];
    const runtime = createModelRuntime();
    runtime.registerProvider({
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        record.push([...messages]);
        // Keep the loop live long enough for the steer to land.
        await new Promise((r) => setTimeout(r, 300));
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    });
    const rt = await createCodingAgentRuntime({
      runId: "r-steer",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: runtime,
      skillRoots: [],
    });
    const segment = await rt.run(runInput("r-steer"));
    // run() resolves only once the loop is live: steer is routable with no
    // timing window.
    await expect(
      rt.steer({ inputId: "steer-1", message: { role: "user", text: "steer me" } }),
    ).resolves.toBeUndefined();
    await segment.outcome;
    await rt.close();
  });

  test("stop before run() starts settles aborted without running", async () => {
    const record: Message[][] = [];
    const runtime = await createCodingAgentRuntime({
      runId: "r-stop",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [],
    });
    await runtime.stop();
    const segment = await runtime.run(runInput("r-stop"));
    const outcome = await segment.outcome;
    expect(outcome).toEqual({ status: "aborted", error: "stopped before start" });
    expect(record).toHaveLength(0); // the model was never called
    await runtime.close();
  });

  test("close() tears down cleanly (idempotent)", async () => {
    const record: Message[][] = [];
    const runtime = await createCodingAgentRuntime({
      runId: "r-close",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: makeModelRuntime(record),
      skillRoots: [],
    });
    const segment = await runtime.run(runInput("r-close"));
    await segment.outcome;
    await runtime.close();
    await runtime.close();
  });

  test("context budget and summarizer bind to the RUN model, never catalog[0]", async () => {
    interface Batch {
      model: Model;
      messages: Message[];
    }
    const batches: Batch[] = [];
    const BIG: Model = { ...FAKE_MODEL, id: "big", contextWindow: 200_000 };
    const SMALL: Model = { ...FAKE_MODEL, id: "small", contextWindow: 4_000 };
    // catalog order: big FIRST - the run uses small.
    const runtime = createModelRuntime();
    runtime.registerProvider({
      id: "fake",
      name: "Fake",
      getModels: () => [BIG, SMALL],
      async *stream(model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        batches.push({ model, messages: [...messages] });
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    });
    const rt = await createCodingAgentRuntime({
      runId: "r-budget",
      modelId: "fake/small",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: runtime,
      skillRoots: [],
    });
    // ~30K chars of history (two messages, 4+ branch entries): ~7.5K
    // estimated tokens - over small(4K)*0.7, far under big(200K)*0.7.
    // Compaction fires ONLY if the budget uses the run model.
    const segment = await rt.run({
      history: [
        { productEntryId: "e1", message: { role: "user", text: "x".repeat(15_000) } },
        { productEntryId: "e2", message: { role: "user", text: "x".repeat(15_000) } },
      ],
      input: { inputId: "in-budget", message: { role: "user", text: "go" } },
      run: {
        runId: "r-budget",
        model: { backendKind: "coding_agent", modelId: "fake/small" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b" },
    });
    const outcome = await segment.outcome;
    expect(outcome.status).toBe("completed");
    // The summarizer ran (proactive compaction) => the budget used the SMALL
    // window, not catalog[0]'s 200K.
    expect(batches.some((b) => b.messages[0]?.role === "system")).toBe(true);
    // BOTH the model stream and the summarizer used the run model.
    expect(batches.length).toBeGreaterThanOrEqual(2);
    for (const b of batches) expect(b.model.id).toBe("small");
    await rt.close();
  });

  test("a run model with a huge window compacts at ITS threshold, not catalog[0]'s small one", async () => {
    interface Batch {
      model: Model;
      messages: Message[];
    }
    const batches: Batch[] = [];
    const SMALL: Model = { ...FAKE_MODEL, id: "small", contextWindow: 4_000 };
    const BIG: Model = { ...FAKE_MODEL, id: "big", contextWindow: 200_000 };
    // catalog order: small FIRST - the run uses big.
    const runtime = createModelRuntime();
    runtime.registerProvider({
      id: "fake",
      name: "Fake",
      getModels: () => [SMALL, BIG],
      async *stream(model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        batches.push({ model, messages: [...messages] });
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    });
    const rt = await createCodingAgentRuntime({
      runId: "r-budget2",
      modelId: "fake/big",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: runtime,
      skillRoots: [],
    });
    // Same ~30K chars (~7.5K tokens): over small(4K)*0.7 - the WRONG budget
    // would compact; the run model's 200K window must not.
    const segment = await rt.run({
      history: [
        { productEntryId: "e1", message: { role: "user", text: "x".repeat(15_000) } },
        { productEntryId: "e2", message: { role: "user", text: "x".repeat(15_000) } },
      ],
      input: { inputId: "in-budget2", message: { role: "user", text: "go" } },
      run: {
        runId: "r-budget2",
        model: { backendKind: "coding_agent", modelId: "fake/big" },
        productTools: [],
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b" },
    });
    await segment.outcome;
    // No summarizer call: no premature compaction.
    expect(batches.some((b) => b.messages[0]?.role === "system")).toBe(false);
    expect(batches[0]!.model.id).toBe("big");
    await rt.close();
  });
});
