import { mkdirSync, rmSync } from "node:fs";
import type { BackendRunInput, BackendRunSegment } from "@chengchenccc/agent-contract";
import type { Model, Provider } from "@chengchenccc/ai";
import { createModelRuntime } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { createOmaRuntime } from "./create-runtime.js";
import { registerBuiltinProviders } from "./run-runtime.js";

process.env.OMA_TITLE_ENABLED = "0";

export { createModelRuntime, createOmaRuntime, registerBuiltinProviders };

export function createRuntimeTestContext() {
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

  function runInput(runId: string, systemPrompt?: string): BackendRunInput<"oma"> {
    const base: BackendRunInput<"oma"> = {
      input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
      run: {
        runId,
        model: { backendKind: "oma", modelId: "fake/echo" },
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentId: "m", branchId: "b" },
    };
    if (systemPrompt) {
      return {
        ...base,
        run: { ...base.run, systemPrompt },
      };
    }
    return base;
  }

  async function settle(segment: BackendRunSegment<"oma">) {
    const outcome = await segment.outcome;
    const events: string[] = [];
    const collect = (async () => {
      for await (const ev of segment.events) events.push(ev.type);
    })();
    await collect;
    return { outcome, events };
  }

  function cleanup() {
    rmSync(tmp, { recursive: true, force: true });
  }

  return {
    tmp,
    FAKE_MODEL,
    recordingProvider,
    makeModelRuntime,
    runInput,
    settle,
    cleanup,
  };
}
