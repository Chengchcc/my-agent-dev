import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackendRunInput, BackendRunSegment } from "@chengchenccc/agent-contract";
import type { Model, Provider } from "@chengchenccc/ai";
import { createModelRuntime } from "@chengchenccc/ai";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import { createOmaRuntime } from "./create-runtime.js";
import { registerBuiltinProviders } from "./run-runtime.js";

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

function runInput(runId: string, systemPrompt?: string): BackendRunInput<"oma"> {
  return {
    input: { inputId: `in-${runId}`, message: { role: "user", text: "go" } },
    run: {
      runId,
      model: { backendKind: "oma", modelId: "fake/echo" },
      ...(systemPrompt ? { systemPrompt } : {}),
      configRevision: 1,
    },
    workspace: { root: tmp, access: "read_write" },
    metadata: { conversationId: "c", agentId: "m", branchId: "b" },
  };
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

// Disable title generation: its extra model call interferes with batch assertions.
process.env.OMA_TITLE_ENABLED = "0";

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("createOmaRuntime", () => {
  test("one runtime = one run: a second run() is rejected", async () => {
    const record: Message[][] = [];
    const runtime = await createOmaRuntime({
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
    const runtime = await createOmaRuntime({
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
    const runtime = await createOmaRuntime({
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
    const rt = await createOmaRuntime({
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
    const runtime = await createOmaRuntime({
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
    const runtime = await createOmaRuntime({
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

  test("a model call beyond OMA_MODEL_TIMEOUT_MS aborts the run", async () => {
    // Provider that never yields before the timeout fires.
    const slow: Provider = {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(): AsyncIterable<AIMessageChunk> {
        await Bun.sleep(500);
        yield { delta: { type: "text", text: "late" } };
        yield { stopReason: "end_turn" };
      },
    };
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(slow);

    const prev = process.env.OMA_MODEL_TIMEOUT_MS;
    process.env.OMA_MODEL_TIMEOUT_MS = "50";
    try {
      const runtime = await createOmaRuntime({
        runId: "r-timeout",
        modelId: "fake/echo",
        workspaceRoot: tmp,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
      });
      const segment = await runtime.run(runInput("r-timeout"));
      const started = Date.now();
      const { outcome } = await settle(segment);
      // The wall-clock timeout must fail the Run — no infinite `running`,
      // and no waiting for the stuck provider (hard abort, not graceful).
      expect(outcome.status).toBe("failed");
      expect(Date.now() - started).toBeLessThan(400);
      await runtime.close();
    } finally {
      if (prev === undefined) delete process.env.OMA_MODEL_TIMEOUT_MS;
      else process.env.OMA_MODEL_TIMEOUT_MS = prev;
    }
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
    const rt = await createOmaRuntime({
      runId: "r-budget",
      modelId: "fake/small",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: runtime,
      skillRoots: [],
      // ~30K chars of history (two messages, 4+ branch entries): ~7.5K
      // estimated tokens - over small(4K)*0.7, far under big(200K)*0.7.
      // Compaction fires ONLY if the budget uses the run model.
      sessionTranscript: [
        { productEntryId: "e1", message: { role: "user", text: "x".repeat(15_000) } },
        { productEntryId: "e2", message: { role: "user", text: "x".repeat(15_000) } },
      ],
    });
    const segment = await rt.run({
      input: { inputId: "in-budget", message: { role: "user", text: "go" } },
      run: {
        runId: "r-budget",
        model: { backendKind: "oma", modelId: "fake/small" },
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentId: "m", branchId: "b" },
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
    const rt = await createOmaRuntime({
      runId: "r-budget2",
      modelId: "fake/big",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime: runtime,
      skillRoots: [],
      // Same ~30K chars (~7.5K tokens): over small(4K)*0.7 - the WRONG
      // budget would compact; the run model's 200K window must not.
      sessionTranscript: [
        { productEntryId: "e1", message: { role: "user", text: "x".repeat(15_000) } },
        { productEntryId: "e2", message: { role: "user", text: "x".repeat(15_000) } },
      ],
    });
    const segment = await rt.run({
      input: { inputId: "in-budget2", message: { role: "user", text: "go" } },
      run: {
        runId: "r-budget2",
        model: { backendKind: "oma", modelId: "fake/big" },
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentId: "m", branchId: "b" },
    });
    await segment.outcome;
    // No summarizer call: no premature compaction.
    expect(batches.some((b) => b.messages[0]?.role === "system")).toBe(false);
    expect(batches[0]!.model.id).toBe("big");
    await rt.close();
  });
  test("run_workflow fans out subagents and reports workflow events (phase 1)", async () => {
    const requests: string[] = [];
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const system = messages.find((m) => m.role === "system");
        if (system?.text.includes("You are a subagent")) {
          requests.push("subagent");
          yield { delta: { type: "text", text: "sub-result" } };
          yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (!requests.includes("tool")) {
          requests.push("tool");
          yield { delta: { type: "tool_use", id: "toolu-1", name: "run_workflow" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "toolu-1",
              partial_json: JSON.stringify({
                items: [
                  { prompt: "one", label: "a" },
                  { prompt: "two", label: "b" },
                ],
              }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        requests.push("main");
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    };
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(provider);
    const runtime = await createOmaRuntime({
      runId: "r-wf",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    const segment = await runtime.run(runInput("r-wf"));
    const { outcome, events } = await settle(segment);
    await runtime.close();
    expect(outcome.status).toBe("completed");
    // Two subagent streams + one main tool turn + one final main turn.
    expect(requests.filter((r) => r === "subagent")).toHaveLength(2);
    expect(events).toContain("workflow_started");
    expect(events).toContain("workflow_agent_started");
    expect(events).toContain("workflow_agent_completed");
    expect(events).toContain("workflow_completed");
    // Fan-out spend merges into the run's terminal usage (B6): 2 subagents
    // + 1 final main turn (the tool_use turn emits no usage) × (10/3/1).
    expect(outcome.usage).toEqual({
      inputTokens: 30,
      outputTokens: 9,
      cacheReadTokens: 3,
      cacheWriteTokens: 0,
    });
  });
  test("workflow_run evaluates a script, fans out agents, and persists .oma/workflow", async () => {
    const requests: string[] = [];
    const script =
      'const a = await agent("one"); const b = await agent("two"); return [a.text, b.text];';
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const system = messages.find((m) => m.role === "system");
        if (system?.text.includes("You are a subagent")) {
          requests.push("subagent");
          yield { delta: { type: "text", text: "sub-result" } };
          yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (!requests.includes("script")) {
          requests.push("script");
          yield { delta: { type: "tool_use", id: "toolu-2", name: "workflow_run" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "toolu-2",
              partial_json: JSON.stringify({ script, name: "audit" }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        requests.push("main");
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    };
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(provider);
    const runtime = await createOmaRuntime({
      runId: "r-wfs",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    const segment = await runtime.run(runInput("r-wfs"));
    const { outcome, events } = await settle(segment);
    await runtime.close();
    expect(outcome.status).toBe("completed");
    expect(requests.filter((r) => r === "subagent")).toHaveLength(2);
    expect(events).toContain("workflow_agent_completed");
    expect(events).toContain("workflow_completed");
    // The script persists to the workspace for inspection/re-runs.
    const saved = await Bun.file(join(tmp, ".oma/workflow", "audit.js")).text();
    expect(saved).toBe(script);
  });

  test("workflow-mode run (input.workflow) executes the script and returns its value", async () => {
    const requests: string[] = [];
    const provider: Provider = {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(model, messages): AsyncIterable<AIMessageChunk> {
        void model;
        const system = messages.find((m) => m.role === "system");
        if (system?.text.includes("You are a subagent")) {
          requests.push("subagent");
          yield { delta: { type: "text", text: "fixed" } };
          yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
          yield { stopReason: "end_turn" };
          return;
        }
        yield { delta: { type: "text", text: "unused" } };
        yield { stopReason: "end_turn" };
      },
    };
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(provider);
    const rt = await createOmaRuntime({
      runId: "r-wf-mode",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    const input: BackendRunInput<"oma"> = {
      input: { inputId: "in-wf", message: { role: "user", text: "" } },
      run: {
        runId: "r-wf-mode",
        model: { backendKind: "oma", modelId: "fake/echo" },
        configRevision: 1,
      },
      workspace: { root: tmp, access: "read_write" },
      metadata: { conversationId: "c", agentId: "m", branchId: "b" },
      workflow: {
        script: 'const a = await agent("fix it"); return { verdict: "PASS", evidence: a.text };',
      },
    };
    const segment = await rt.run(input);
    const outcome = await segment.outcome;
    await rt.close();

    expect(outcome.status).toBe("completed");
    expect(outcome.workflow?.ok).toBe(true);
    expect(outcome.workflow?.value).toEqual({ verdict: "PASS", evidence: "fixed" });
    // No main loop call — only the subagent streamed; its usage is exposed
    // as top-level run usage so product accounting sees it (B6).
    expect(requests).toEqual(["subagent"]);
    expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 14 });
  });
  test("native todo installs when no MCP todo_write is injected (standalone)", async () => {
    const savedFake = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "todo_write", input: { items: [{ id: "t1", text: "plan", status: "pending" }] } },
    ]);
    try {
      const modelRuntime = createModelRuntime();
      registerBuiltinProviders(modelRuntime, process.env);
      const rt = await createOmaRuntime({
        runId: "r-todo-native",
        modelId: "fake/echo",
        workspaceRoot: tmp,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
      });
      const segment = await rt.run(runInput("r-todo-native"));
      const outcome = await segment.outcome;
      await rt.close();
      expect(outcome.status).toBe("completed");
      const todo = JSON.parse(readFileSync(join(tmp, ".oma", "todo.json"), "utf8")) as {
        items: Array<{ id: string; text: string; status: string }>;
      };
      expect(todo.items).toEqual([{ id: "t1", text: "plan", status: "pending" }]);
    } finally {
      if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedFake;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  });

  test("plugin code tools load into the Run; permissionMode deny drops them", async () => {
    const savedFake = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "plug-hello", input: {} },
      { name: "plug-hello", input: {} },
    ]);
    const toolsRecord = join(tmp, "plug-tools-record.json");
    process.env.OMA_FAKE_TOOLS_RECORD = toolsRecord;
    try {
      const mk = (permissionMode?: "ask" | "auto" | "deny") => {
        const modelRuntime = createModelRuntime();
        registerBuiltinProviders(modelRuntime, process.env);
        return createOmaRuntime({
          runId: `r-plug-${permissionMode ?? "none"}`,
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime,
          skillRoots: [],
          pluginComponents: {
            plugins: [
              {
                name: "plugin:plug",
                tools: [
                  {
                    name: "plug-hello",
                    description: "plugin tool",
                    executionMode: "concurrent",
                    async execute() {
                      return { content: "hello from plugin" };
                    },
                  },
                ],
              },
            ],
          },
          ...(permissionMode ? { permissionMode } : {}),
        });
      };

      // Denied first (fake-tool script is module-level state; one entry per
      // model call): the plugin tool is NOT in the table, so the scripted
      // call lands as an unknown-tool error result.
      const denied = await mk("deny");
      const seg2 = await denied.run(runInput("r-plug-deny"));
      const out2 = await seg2.outcome;
      await denied.close();
      expect(out2.status).toBe("completed"); // deny drops plugin tools; Run fine
      expect(JSON.stringify(out2.messages)).toContain("Unknown tool: plug-hello");

      // Allowed second: the remaining scripted call executes the plugin tool
      // and its content lands verbatim (content contract).
      const allowed = await mk(undefined);
      const seg1 = await allowed.run(runInput("r-plug-none"));
      const out1 = await seg1.outcome;
      await allowed.close();
      expect(out1.status).toBe("completed");
      expect(JSON.stringify(out1.messages)).toContain("hello from plugin");
    } finally {
      delete process.env.OMA_FAKE_TOOLS_RECORD;
      if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedFake;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  });

  test("permissionMode ask routes plugin tools through the approval handler", async () => {
    const savedFake = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    const asked: string[] = [];
    let runSeq = 0;
    try {
      const mk = (verdict: "allow" | "deny" | "none") => {
        const modelRuntime = createModelRuntime();
        registerBuiltinProviders(modelRuntime, process.env);
        runSeq++;
        return createOmaRuntime({
          runId: `r-ask-${runSeq}`,
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime,
          skillRoots: [],
          permissionMode: "ask",
          ...(verdict !== "none"
            ? {
                approvalHandler: async (req: { toolName: string }) => {
                  asked.push(req.toolName);
                  return { decision: verdict };
                },
              }
            : {}),
          pluginComponents: {
            plugins: [
              {
                name: "plugin:plug",
                tools: [
                  {
                    name: "plug-hello",
                    description: "plugin tool",
                    executionMode: "concurrent",
                    async execute() {
                      return { content: "hello from plugin" };
                    },
                  },
                ],
              },
            ],
          },
        });
      };
      const oneRun = async (v: "allow" | "deny" | "none") => {
        process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "plug-hello", input: {} }]);
        const rt = await mk(v);
        const seg = await rt.run(runInput(`r-ask-${runSeq}`));
        const out = await seg.outcome;
        await rt.close();
        return JSON.stringify(out.messages);
      };

      // deny: tool never executes; error result names the denial.
      expect(await oneRun("deny")).toContain("denied");
      // allow: proceeds (content verbatim).
      expect(await oneRun("allow")).toContain("hello from plugin");
      expect(asked).toEqual(["plug-hello", "plug-hello"]);
      // no handler: fail-closed error, no pipeline.
      expect(await oneRun("none")).toContain("no pipeline");
    } finally {
      if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedFake;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  });

  test("permissionMode gates native bash tool through the approval pipeline", async () => {
    const savedFake = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    const asked: string[] = [];
    let seq = 0;
    try {
      const mk = (permissionMode: "ask" | "deny" | "auto", handler: boolean) => {
        const rt = createModelRuntime();
        registerBuiltinProviders(rt, process.env);
        seq++;
        return createOmaRuntime({
          runId: `r-nativegate-${seq}`,
          modelId: "fake/echo",
          workspaceRoot: tmp,
          workspaceAccess: "read_write",
          modelRuntime: rt,
          skillRoots: [],
          permissionMode,
          ...(handler
            ? {
                approvalHandler: async (req: { toolName: string }) => {
                  asked.push(req.toolName);
                  return { decision: "deny" };
                },
              }
            : {}),
        });
      };
      const oneRun = async (v: "ask" | "deny" | "auto", handler: boolean) => {
        process.env.OMA_FAKE_TOOL = JSON.stringify([
          { name: "bash", input: { command: "echo hi", timeout: 1000 } },
        ]);
        const rt = await mk(v, handler);
        const seg = await rt.run(runInput(`r-nativegate-${seq}`));
        const out = await seg.outcome;
        await rt.close();
        return JSON.stringify(out.messages);
      };

      // deny: native bash blocked outright (no handler needed).
      expect(await oneRun("deny", false)).toContain("blocked by permissionMode=deny");
      // ask + handler returns deny: native bash blocked via approval.
      expect(await oneRun("ask", true)).toContain("denied");
      expect(asked).toEqual(["bash"]);
      // ask + no handler: fail-closed.
      expect(await oneRun("ask", false)).toContain("no pipeline");
      // auto (CC alignment): bash routes through the classifier; the fake
      // provider's default text ("done") is not a verdict JSON →
      // fail-closed block.
      const auto = await oneRun("auto", false);
      expect(auto).toContain("blocked by classifier");
    } finally {
      if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedFake;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  });
});

describe("bash sandbox via .oma/settings.json (BashSandbox design P4)", () => {
  const HAS_BWRAP = Bun.which("bwrap") !== null;
  const ws = mkdtempSync(join(tmpdir(), "oma-sbx-ws-"));
  afterAll(() => rmSync(ws, { recursive: true, force: true }));
  afterEach(() => {
    delete process.env.OMA_FAKE_PROVIDER;
    delete process.env.OMA_FAKE_TOOL;
  });

  (HAS_BWRAP ? test : test.skip)(
    "settings bashSandbox:true confines the Run's bash tool (network blocked)",
    async () => {
      mkdirSync(join(ws, ".oma"), { recursive: true });
      writeFileSync(
        join(ws, ".oma", "settings.json"),
        JSON.stringify({ bashSandbox: true }),
        "utf8",
      );
      process.env.OMA_FAKE_PROVIDER = "1";
      process.env.OMA_FAKE_TOOL = JSON.stringify([
        {
          name: "bash",
          input: {
            description: "probe",
            // /dev/tcp is a bash builtin — no curl needed. Under bwrap
            // --unshare-net this fails; unsandboxed it succeeds.
            command:
              "timeout 3 bash -c 'echo x > /dev/tcp/1.1.1.1/80' && echo NET-OPEN || echo net-blocked",
          },
        },
      ]);
      const modelRuntime = createModelRuntime();
      registerBuiltinProviders(modelRuntime, process.env);
      const rt = await createOmaRuntime({
        runId: "r-sbx-on",
        modelId: "fake/echo",
        workspaceRoot: ws,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
      });
      try {
        const segment = await rt.run({
          ...runInput("r-sbx-on"),
          workspace: { root: ws, access: "read_write" },
        });
        const outcome = await segment.outcome;
        const text = JSON.stringify(outcome.messages);
        expect(text).toContain("net-blocked");
        // The OS network namespace denied the connection; asserting the
        // error (not absence of "NET-OPEN" — that string lives in the echoed
        // tool_use input too).
        expect(text).toContain("Network is unreachable");
      } finally {
        await rt.close();
      }
    },
    20_000,
  );

  test("settings bashSandbox absent (default) leaves bash unconstrained", async () => {
    // No settings.json in this workspace → Null sandbox → /dev/tcp to the
    // loopback-bound port below succeeds, proving no confinement layer.
    const plainWs = mkdtempSync(join(tmpdir(), "oma-sbx-off-"));
    try {
      const savedProvider = process.env.OMA_FAKE_PROVIDER;
      const savedTool = process.env.OMA_FAKE_TOOL;
      process.env.OMA_FAKE_PROVIDER = "1";
      process.env.OMA_FAKE_TOOL = JSON.stringify([
        { name: "bash", input: { description: "probe", command: "echo unconstrained-ok" } },
      ]);
      const modelRuntime = createModelRuntime();
      registerBuiltinProviders(modelRuntime, process.env);
      const rt = await createOmaRuntime({
        runId: "r-sbx-off",
        modelId: "fake/echo",
        workspaceRoot: plainWs,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
      });
      const segment = await rt.run({
        ...runInput("r-sbx-off"),
        workspace: { root: plainWs, access: "read_write" },
      });
      const outcome = await segment.outcome;
      expect(JSON.stringify(outcome.messages)).toContain("unconstrained-ok");
      await rt.close();
      if (savedProvider === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedProvider;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    } finally {
      rmSync(plainWs, { recursive: true, force: true });
    }
  });
});

describe("permissionMode auto classifier gate (CC alignment)", () => {
  /** One auto-mode run against the fake provider: script drives the model's
   * tool call, OMA_FAKE_TEXT is the classifier verdict (the fake script
   * queue is empty by the time the gate's classifier call runs). Returns
   * the serialized outcome messages. */
  const autoRun = async (opts: {
    runId: string;
    script: Array<{ name: string; input: Record<string, unknown> }>;
    text: string;
    permissionMode?: "ask" | "auto" | "deny";
    pluginTool?: { name: string; execute: () => Promise<Record<string, unknown>> };
    approvalHandler?: (req: {
      toolName: string;
      reason?: string;
      source?: string;
    }) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
  }): Promise<string> => {
    process.env.OMA_FAKE_TOOL = JSON.stringify(opts.script);
    process.env.OMA_FAKE_TEXT = opts.text;
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const pluginComponents = opts.pluginTool
      ? {
          plugins: [
            {
              name: "plugin:plug",
              tools: [
                {
                  name: opts.pluginTool.name,
                  description: "plugin tool",
                  inputSchema: { type: "object", properties: {}, required: [] },
                  execute: opts.pluginTool.execute,
                },
              ],
            },
          ],
        }
      : undefined;
    const rt = await createOmaRuntime({
      runId: opts.runId,
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
      ...(pluginComponents ? { pluginComponents } : {}),
      ...(opts.approvalHandler ? { approvalHandler: opts.approvalHandler as never } : {}),
    });
    const seg = await rt.run(runInput(opts.runId));
    const out = await seg.outcome;
    await rt.close();
    return JSON.stringify(out.messages);
  };

  const withFakes = (fn: () => Promise<void>) => async () => {
    const saved = ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"].map(
      (k) => process.env[k],
    );
    process.env.OMA_FAKE_PROVIDER = "1";
    try {
      await fn();
    } finally {
      ["OMA_FAKE_PROVIDER", "OMA_FAKE_TOOL", "OMA_FAKE_TEXT"].forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
    }
  };

  test(
    "classifier allow executes bash; block denies with the reason",
    withFakes(async () => {
      const script = [
        { name: "bash", input: { description: "d", command: "echo x > marker-auto.txt" } },
      ];
      const allowed = await autoRun({
        runId: "r-auto-allow",
        script,
        text: '{"verdict":"allow"}',
        permissionMode: "auto",
      });
      expect(allowed).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "marker-auto.txt"))).toBe(true);

      const blocked = await autoRun({
        runId: "r-auto-block",
        script,
        text: '{"verdict":"block","reason":"deletes home files"}',
        permissionMode: "auto",
      });
      expect(blocked).toContain("blocked by classifier");
      expect(blocked).toContain("deletes home files");
    }),
  );

  test(
    "write skips the classifier (workspace-sandboxed)",
    withFakes(async () => {
      const out = await autoRun({
        runId: "r-auto-write",
        script: [{ name: "write", input: { description: "d", path: "w-auto.txt", content: "hi" } }],
        // The classifier would block everything — write must not consult it.
        text: '{"verdict":"block","reason":"never"}',
        permissionMode: "auto",
      });
      expect(out).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "w-auto.txt"))).toBe(true);
    }),
  );

  test(
    "absent permissionMode stays ungated (legacy standalone default)",
    withFakes(async () => {
      const out = await autoRun({
        runId: "r-auto-absent",
        script: [
          { name: "bash", input: { description: "d", command: "echo y > marker-absent.txt" } },
        ],
        text: '{"verdict":"block","reason":"never"}',
      });
      expect(out).not.toContain("blocked by classifier");
      expect(existsSync(join(tmp, "marker-absent.txt"))).toBe(true);
    }),
  );

  test(
    "plugin code tools are classified under auto",
    withFakes(async () => {
      let executed = false;
      const out = await autoRun({
        runId: "r-auto-plugin",
        script: [{ name: "plug-hello", input: {} }],
        text: '{"verdict":"block","reason":"untrusted plugin effect"}',
        permissionMode: "auto",
        pluginTool: {
          name: "plug-hello",
          execute: async () => {
            executed = true;
            return { content: "PLUG-OK" };
          },
        },
      });
      expect(out).toContain("blocked by classifier");
      expect(out).toContain("untrusted plugin effect");
      expect(executed).toBe(false);
    }),
  );

  test(
    "a classifier block escalates to the human ONCE per unique action",
    withFakes(async () => {
      const escalations: string[] = [];
      const bash = {
        name: "bash",
        input: { description: "d", command: "echo z > marker-esc.txt" },
      };
      const out = await autoRun({
        runId: "r-auto-escalate",
        // Three identical calls; the classifier consumes script slots, so:
        // call1 pops bash#1, its classifier pops bash#2 (tool_use stream →
        // no verdict → block) → escalates → human allows → executes;
        // call2 pops bash#3, its classifier reads the text verdict → block
        // → dedupe: silent deny, no second card; call3 ends the turn.
        script: [bash, bash, bash],
        text: '{"verdict":"block","reason":"looks destructive"}',
        permissionMode: "auto",
        approvalHandler: async (req) => {
          escalations.push(`${req.source}:${req.toolName}`);
          return { decision: "allow" };
        },
      });
      // Exactly ONE escalation: first occurrence human-overridden → executed.
      expect(escalations).toEqual(["classifier:bash"]);
      expect(existsSync(join(tmp, "marker-esc.txt"))).toBe(true);
      // Second identical occurrence: denied again with the text verdict
      // (every denial is reported to the model) but WITHOUT a second card.
      expect(out).toContain("blocked by classifier — looks destructive");
      expect(out.match(/blocked by classifier/g)?.length).toBe(2);
    }),
  );

  test(
    "human denial keeps the block; critical-path rm never escalates and never runs",
    withFakes(async () => {
      let escalations = 0;
      const denied = await autoRun({
        runId: "r-auto-human-deny",
        script: [{ name: "bash", input: { description: "d", command: "echo a > marker-hd.txt" } }],
        text: '{"verdict":"block","reason":"risky"}',
        permissionMode: "auto",
        approvalHandler: async () => {
          escalations++;
          return { decision: "deny" };
        },
      });
      expect(denied).toContain("(human denied)");
      expect(existsSync(join(tmp, "marker-hd.txt"))).toBe(false);

      // Critical deletion: hard block BEFORE the classifier (verdict would
      // allow) and BEFORE any human card.
      const critical = await autoRun({
        runId: "r-auto-critical",
        script: [{ name: "bash", input: { description: "d", command: "rm -rf /" } }],
        text: '{"verdict":"allow"}',
        permissionMode: "auto",
        approvalHandler: async () => {
          escalations++;
          return { decision: "allow" };
        },
      });
      expect(critical).toContain("critical-path deletion");
      expect(critical).not.toContain("(human denied)");
      expect(escalations).toBe(1); // only the human-deny case escalated
    }),
  );
});

test("injected MCP todo_write wins over native todo (backend-injected priority)", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  const savedTool = process.env.OMA_FAKE_TOOL;
  process.env.OMA_FAKE_PROVIDER = "1";
  // Model calls todo_write; the MCP server (echo fixture via .mcp.json)
  // provides it, so native todo must NOT be installed — the call lands on
  // the MCP tool (content "ok:todo_write"), and no .oma/todo.json exists.
  process.env.OMA_FAKE_TOOL = JSON.stringify([{ name: "todo_write", input: { items: [] } }]);
  const ws = mkdtempSync(join(tmpdir(), "oma-todo-mcp-"));
  try {
    process.env.MCP_ECHO_TOOLS = "todo_write";
    writeFileSync(
      join(ws, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "echo-server": {
            command: "bun",
            args: [join(import.meta.dir, "../__fixtures__/mcp-echo-server.ts")],
            env: { MCP_ECHO_TOOLS: "todo_write" },
          },
        },
      }),
    );
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const rt = await createOmaRuntime({
      runId: "r-todo-mcp",
      modelId: "fake/echo",
      workspaceRoot: ws,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
    });
    const segment = await rt.run(runInput("r-todo-mcp"));
    const outcome = await segment.outcome;
    await rt.close();
    expect(outcome.status).toBe("completed");
    const raw = JSON.stringify(outcome.messages);
    // The MCP echo server answered (it echoes {name,...}); native todo
    // would have written .oma/todo.json instead.
    expect(raw).toContain("todo_write");
    expect(existsSync(join(ws, ".oma", "todo.json"))).toBe(false);
  } finally {
    delete process.env.MCP_ECHO_TOOLS;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
    if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
    else process.env.OMA_FAKE_TOOL = savedTool;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("--tools filter: whitelist hides unlisted tools from the model", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  process.env.OMA_FAKE_PROVIDER = "1";
  process.env.OMA_FAKE_TOOLS_RECORD = join(tmp, "tools-record.json");
  try {
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const { parseToolFilter } = await import("./tool-filter.js");
    const rt = await createOmaRuntime({
      runId: "r-tools-filter",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      toolFilter: parseToolFilter("read,write"),
    });
    const segment = await rt.run(runInput("r-tools-filter"));
    await segment.outcome;
    await rt.close();
    const table = JSON.parse(await Bun.file(join(tmp, "tools-record.json")).text()) as string[];
    expect(table).toContain("read");
    expect(table).toContain("write");
    expect(table).not.toContain("bash");
    expect(table).not.toContain("web_search");
  } finally {
    delete process.env.OMA_FAKE_TOOLS_RECORD;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
  }
});

test("--tools filter: blacklist (!name) keeps everything else", async () => {
  const savedFake = process.env.OMA_FAKE_PROVIDER;
  process.env.OMA_FAKE_PROVIDER = "1";
  process.env.OMA_FAKE_TOOLS_RECORD = join(tmp, "tools-record2.json");
  try {
    const modelRuntime = createModelRuntime();
    registerBuiltinProviders(modelRuntime, process.env);
    const { parseToolFilter } = await import("./tool-filter.js");
    const rt = await createOmaRuntime({
      runId: "r-tools-deny",
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      toolFilter: parseToolFilter("!bash,!web_search"),
    });
    const segment = await rt.run(runInput("r-tools-deny"));
    await segment.outcome;
    await rt.close();
    const table = JSON.parse(await Bun.file(join(tmp, "tools-record2.json")).text()) as string[];
    expect(table).not.toContain("bash");
    expect(table).not.toContain("web_search");
    expect(table).toContain("read");
  } finally {
    delete process.env.OMA_FAKE_TOOLS_RECORD;
    if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
    else process.env.OMA_FAKE_PROVIDER = savedFake;
  }
});

describe("workflow subagents obey the permission gate", () => {
  /** Provider dispatches on the system prompt: the classifier branch sees
   *  the permission-classifier system text, subagents see the subagent
   *  system prompt, the main loop sees neither. This makes the interleaved
   *  model calls (main → subagent → subagent's classifier) deterministic
   *  without the OMA_FAKE_TOOL script queue. */
  function gatingProvider(requests: string[], verdictText: string): Provider {
    return {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const system = messages.find((m) => m.role === "system")?.text ?? "";
        if (system.includes("permission classifier")) {
          requests.push("classifier");
          yield { delta: { type: "text", text: verdictText } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (system.includes("subagent")) {
          if (!requests.includes("sub-tool")) {
            requests.push("sub-tool");
            yield { delta: { type: "tool_use", id: "t-sub", name: "bash" } };
            yield {
              delta: {
                type: "input_json_delta",
                id: "t-sub",
                partial_json: JSON.stringify({
                  description: "d",
                  command: "echo s > sub-marker.txt",
                }),
              },
            };
            yield { stopReason: "tool_use" };
            return;
          }
          requests.push("sub-done");
          // The denied tool result must have been fed back to the subagent.
          if (messages.some((m) => JSON.stringify(m).includes("blocked by classifier"))) {
            requests.push("sub-saw-classifier-block");
          }
          if (messages.some((m) => JSON.stringify(m).includes("blocked by permissionMode=deny"))) {
            requests.push("sub-saw-deny-block");
          }
          yield { delta: { type: "text", text: "sub finished" } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (!requests.includes("tool")) {
          requests.push("tool");
          yield { delta: { type: "tool_use", id: "t-main", name: "run_workflow" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "t-main",
              partial_json: JSON.stringify({
                items: [{ prompt: "write a marker file with bash", label: "a" }],
              }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        requests.push("main");
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    };
  }

  const subagentRun = async (opts: {
    runId: string;
    permissionMode: "ask" | "auto" | "deny";
    verdictText: string;
    requests: string[];
  }): Promise<string> => {
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(gatingProvider(opts.requests, opts.verdictText));
    const rt = await createOmaRuntime({
      runId: opts.runId,
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      permissionMode: opts.permissionMode,
    });
    const seg = await rt.run(runInput(opts.runId));
    const out = await seg.outcome;
    await rt.close();
    return JSON.stringify(out.messages);
  };

  test("auto: subagent bash routes through the classifier and is denied", async () => {
    const requests: string[] = [];
    await subagentRun({
      runId: "r-sub-auto",
      permissionMode: "auto",
      verdictText: '{"verdict":"block","reason":"subagent destructive"}',
      requests,
    });
    expect(requests).toContain("classifier");
    // The denial (with reason) was fed back to the SUBAGENT's model.
    expect(requests).toContain("sub-saw-classifier-block");
    expect(existsSync(join(tmp, "sub-marker.txt"))).toBe(false);
  });

  test("deny: subagent bash is blocked outright (pre-existing gap, now closed)", async () => {
    const requests: string[] = [];
    await subagentRun({
      runId: "r-sub-deny",
      permissionMode: "deny",
      verdictText: '{"verdict":"allow"}',
      requests,
    });
    expect(requests).toContain("sub-saw-deny-block");
    expect(requests).not.toContain("classifier");
    expect(existsSync(join(tmp, "sub-marker.txt"))).toBe(false);
  });
});
