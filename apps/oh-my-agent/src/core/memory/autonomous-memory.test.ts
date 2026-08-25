import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime, type Model, type ModelRuntime, type Provider } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { extractAutonomousMemory } from "./autonomous-memory.js";

const FAKE_MODEL: Model = {
  id: "m",
  name: "M",
  provider: "fake",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

const MESSAGES: readonly Message[] = [
  { role: "user", text: "fix the login flow" },
  { role: "assistant", text: "The JWT expiry is 15m, configured in auth-service.ts" },
];

const ORIG_EXTRACT = process.env.OMA_MEMORY_EXTRACT;
const tmpDirs: string[] = [];

function makeRuntime(replies: string[]): { runtime: ModelRuntime; calls: string[] } {
  const calls: string[] = [];
  const provider: Provider = {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(model, messages): AsyncIterable<AIMessageChunk> {
      void model;
      calls.push(messages[0]?.text ?? "");
      const reply = replies.shift() ?? "";
      yield { delta: { type: "text", text: reply } };
      yield { stopReason: "end_turn" };
    },
  };
  const runtime = createModelRuntime();
  runtime.registerProvider(provider);
  return { runtime, calls };
}

function freshWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "oma-memory-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.env.OMA_MEMORY_EXTRACT = ORIG_EXTRACT;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("extractAutonomousMemory", () => {
  test("extracts facts and merges the summary", async () => {
    const { runtime, calls } = makeRuntime([
      JSON.stringify({
        facts: [{ content: "JWT expiry is 15m", context: "auth-service.ts" }],
      }),
      "## Key Decisions\n- JWT expiry 15m",
    ]);
    const root = freshWorkspace();

    const result = await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-1",
      messages: MESSAGES,
      compactions: ["fixed the login flow"],
    });

    expect(result).toEqual({ ran: true, freshFacts: 1 });

    expect(calls).toHaveLength(2);
    const factsFile = join(root, ".oma", "memory", "facts", "run-1.md");
    expect(existsSync(factsFile)).toBe(true);
    expect(readFileSync(factsFile, "utf-8")).toContain("JWT expiry is 15m");
    expect(readFileSync(join(root, ".oma", "memory", "memory_summary.md"), "utf-8")).toContain(
      "Key Decisions",
    );
  });

  test("OMA_MEMORY_EXTRACT=0 disables the pipeline", async () => {
    process.env.OMA_MEMORY_EXTRACT = "0";
    const { runtime, calls } = makeRuntime([JSON.stringify({ facts: [] })]);
    const root = freshWorkspace();

    const result = await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-2",
      messages: MESSAGES,
      compactions: [],
    });

    expect(result).toEqual({ ran: false, freshFacts: 0 });

    expect(calls).toHaveLength(0);
    expect(existsSync(join(root, ".oma", "memory"))).toBe(false);
  });

  test("empty facts writes nothing", async () => {
    const { runtime, calls } = makeRuntime([JSON.stringify({ facts: [] })]);
    const root = freshWorkspace();

    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-3",
      messages: MESSAGES,
      compactions: [],
    });

    expect(calls).toHaveLength(1); // extract call only, no consolidate
    expect(existsSync(join(root, ".oma", "memory"))).toBe(false);
  });

  test("invalid JSON output is ignored without throwing", async () => {
    const { runtime, calls } = makeRuntime(["not json at all"]);
    const root = freshWorkspace();

    await expect(
      extractAutonomousMemory({
        modelRuntime: runtime,
        modelId: "fake/m",
        workspaceRoot: root,
        runId: "run-4",
        messages: MESSAGES,
        compactions: [],
      }),
    ).resolves.toEqual({ ran: true, freshFacts: 0 });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(root, ".oma", "memory"))).toBe(false);
  });

  test("model failure never fails the run", async () => {
    const failing: ModelRuntime = {
      ...createModelRuntime(),
      async *stream() {
        yield* (async function* (): AsyncGenerator<AIMessageChunk> {
          yield { delta: { type: "text", text: "" } } as AIMessageChunk;
          throw new Error("provider boom");
        })();
      },
    };
    const root = freshWorkspace();

    await expect(
      extractAutonomousMemory({
        modelRuntime: failing,
        modelId: "fake/m",
        workspaceRoot: root,
        runId: "run-5",
        messages: MESSAGES,
        compactions: [],
      }),
    ).resolves.toEqual({ ran: false, freshFacts: 0 });
    expect(existsSync(join(root, ".oma", "memory"))).toBe(false);
  });

  test("facts file is deterministic per runId (no duplicates accumulate)", async () => {
    const { runtime } = makeRuntime([
      JSON.stringify({ facts: [{ content: "fact a" }] }),
      "summary a",
      JSON.stringify({ facts: [{ content: "fact b" }] }),
      "summary b",
    ]);
    const root = freshWorkspace();

    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-6",
      messages: MESSAGES,
      compactions: [],
    });
    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-6",
      messages: MESSAGES,
      compactions: [],
    });

    const factsDir = join(root, ".oma", "memory", "facts");
    expect(readdirSync(factsDir)).toEqual(["run-6.md"]);
    expect(readFileSync(join(factsDir, "run-6.md"), "utf-8")).toContain("fact b");
  });

  test("duplicate facts across runs are not persisted twice", async () => {
    const { runtime, calls } = makeRuntime([
      JSON.stringify({ facts: [{ content: "JWT expiry is 15m" }] }),
      "summary a",
      JSON.stringify({
        facts: [{ content: "JWT expiry is 15m" }, { content: "Rate limit is 100/min" }],
      }),
      "summary b",
    ]);
    const root = freshWorkspace();

    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-d1",
      messages: MESSAGES,
      compactions: [],
    });
    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "fake/m",
      workspaceRoot: root,
      runId: "run-d2",
      messages: MESSAGES,
      compactions: [],
    });

    const first = readFileSync(join(root, ".oma", "memory", "facts", "run-d1.md"), "utf-8");
    const second = readFileSync(join(root, ".oma", "memory", "facts", "run-d2.md"), "utf-8");
    expect(first).toContain("JWT expiry is 15m");
    // run 2 kept only the NEW fact; the duplicate was dropped
    expect(second).not.toContain("JWT expiry is 15m");
    expect(second).toContain("Rate limit is 100/min");
    // consolidation ran for both runs (each produced fresh facts)
    expect(calls).toHaveLength(4);
  });

  test("uses the cheapest catalog model, not the run model", async () => {
    const usedModels: string[] = [];
    const cheap: Provider = {
      id: "cheap",
      name: "Cheap",
      getModels: () => [
        {
          ...FAKE_MODEL,
          id: "cheap-m",
          provider: "cheap",
          cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      async *stream(model, messages): AsyncIterable<AIMessageChunk> {
        usedModels.push(`${model.provider}/${model.id}`);
        yield {
          delta: {
            type: "text",
            text: JSON.stringify({ facts: [{ content: "cheap fact" }] }),
          },
        };
        yield { stopReason: "end_turn" };
        void messages;
      },
    };
    const expensive: Provider = {
      id: "exp",
      name: "Expensive",
      getModels: () => [
        {
          ...FAKE_MODEL,
          id: "exp-m",
          provider: "exp",
          cost: { input: 10, output: 25, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      async *stream(model, messages): AsyncIterable<AIMessageChunk> {
        usedModels.push(`${model.provider}/${model.id}`);
        yield { delta: { type: "text", text: "summary" } };
        yield { stopReason: "end_turn" };
        void messages;
      },
    };
    const runtime = createModelRuntime();
    runtime.registerProvider(cheap);
    runtime.registerProvider(expensive);
    const root = freshWorkspace();

    await extractAutonomousMemory({
      modelRuntime: runtime,
      modelId: "exp/exp-m", // the Run itself uses the expensive model
      workspaceRoot: root,
      runId: "run-cheap",
      messages: MESSAGES,
      compactions: [],
    });

    // extract + consolidate both ran on the cheap model
    expect(usedModels).toEqual(["cheap/cheap-m", "cheap/cheap-m"]);
    expect(readFileSync(join(root, ".oma", "memory", "facts", "run-cheap.md"), "utf-8")).toContain(
      "cheap fact",
    );
  });
});
