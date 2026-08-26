import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIMessageChunk } from "@chengchenccc/core";
import { createInMemorySessionStore } from "../persistence/in-memory-session-store.js";
import { createOmaSession } from "../runtime/agent-loop.js";
import { addMarketplace, installPlugin } from "./plugin-marketplace.js";
import { assemblePluginRuntime } from "./plugin-resolve.js";

test("installed plugin tool executes in a Run (e2e)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "oma-e2e-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-e2e-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  try {
    const marketRoot = join(workspace, "market");
    mkdirSync(join(marketRoot, "e2e", "skills", "e2e"), { recursive: true });
    writeFileSync(
      join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "e2e", path: "e2e" }] }),
    );
    writeFileSync(join(marketRoot, "e2e", "skills", "e2e", "SKILL.md"), "---\nname: e2e\n---\nb");
    writeFileSync(
      join(marketRoot, "e2e", "plugin.json"),
      JSON.stringify({ name: "e2e", tools: "./tools.ts" }),
    );
    writeFileSync(
      join(marketRoot, "e2e", "tools.ts"),
      `
      export const tools = [{
        name: "e2e-tool", description: "e2e", executionMode: "concurrent",
        async execute() { return { content: "E2E-OK" }; },
      }];
    `,
    );
    expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
    expect(installPlugin(workspace, "m/e2e", "user").ok).toBe(true);

    const assembled = await assemblePluginRuntime(workspace, "tui");
    expect(assembled.warnings).toEqual([]);
    expect(assembled.plugins[0]?.tools?.map((t) => t.name)).toEqual(["e2e-tool"]);

    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "e2e",
      backendKind: "oma",
      workspaceRoot: workspace,
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let turn = 0;
    const session = createOmaSession({
      sessionId: "e2e",
      store,
      plugins: assembled.plugins,
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "s",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "e2e-tool" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop({
      input: { inputId: "in", message: { role: "user", text: "go" } },
      run: { runId: "r", model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: workspace, access: "read_write" },
    } as never);
    const snap = await store.open("e2e");
    const raw = JSON.stringify(snap.entries);
    expect(raw).toContain("E2E-OK"); // content contract: verbatim, not JSON-dumped
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("project-scope plugin trust chain in a real Run: untrusted skipped, trusted executes, rpc never", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "oma-e2e-proj-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-e2e-proj-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "market");
  try {
    mkdirSync(join(marketRoot, "proj", "skills", "proj"), { recursive: true });
    writeFileSync(
      join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "proj", path: "proj" }] }),
    );
    writeFileSync(
      join(marketRoot, "proj", "skills", "proj", "SKILL.md"),
      "---\nname: proj\n---\nb",
    );
    writeFileSync(
      join(marketRoot, "proj", "plugin.json"),
      JSON.stringify({ name: "proj", tools: "./tools.ts" }),
    );
    writeFileSync(
      join(marketRoot, "proj", "tools.ts"),
      `export const tools = [{
        name: "proj-tool", description: "project tool", executionMode: "concurrent",
        async execute() { return { content: "PROJ-OK" }; },
      }];`,
    );
    expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
    expect(installPlugin(workspace, "m/proj", "project").ok).toBe(true);

    // tui mode, untrusted: the Run must NOT see the plugin tool.
    const untrusted = await assemblePluginRuntime(workspace, "tui");
    expect(untrusted.plugins).toEqual([]);
    expect(untrusted.warnings.join(" ")).toContain("/plugin trust");

    // Trust it, then the Run sees + executes the tool.
    const { trustPlugin } = await import("./plugin-trust.js");
    trustPlugin(join(workspace, ".oma", "plugins", "proj"));
    const trusted = await assemblePluginRuntime(workspace, "tui");
    expect(trusted.plugins.length).toBe(1);
    expect(trusted.plugins[0]?.tools?.map((t) => t.name)).toEqual(["proj-tool"]);

    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "proj-e2e",
      backendKind: "oma",
      workspaceRoot: workspace,
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let turn = 0;
    const session = createOmaSession({
      sessionId: "proj-e2e",
      store,
      plugins: trusted.plugins,
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "s",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "proj-tool" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop({
      input: { inputId: "in", message: { role: "user", text: "go" } },
      run: { runId: "r", model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: workspace, access: "read_write" },
    } as never);
    const snap = await store.open("proj-e2e");
    expect(JSON.stringify(snap.entries)).toContain("PROJ-OK");

    // rpc mode: even after trust, project-scope code NEVER loads.
    const rpc = await assemblePluginRuntime(workspace, "rpc");
    expect(rpc.plugins).toEqual([]);
    expect(rpc.warnings.join(" ")).toContain("rpc");
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("plugin tool does REAL file I/O in the workspace (not a stub export)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "oma-e2e-io-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-e2e-io-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "market");
  const dataFile = join(workspace, "notes.txt");
  try {
    writeFileSync(dataFile, "alpha\nbeta\ngamma");
    mkdirSync(join(marketRoot, "io"), { recursive: true });
    writeFileSync(
      join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "io", path: "io" }] }),
    );
    writeFileSync(
      join(marketRoot, "io", "plugin.json"),
      JSON.stringify({ name: "io", tools: "./tools.ts" }),
    );
    // Real I/O: read the workspace file, count lines, return formatted content.
    writeFileSync(
      join(marketRoot, "io", "tools.ts"),
      `import { readFileSync } from "node:fs";
      export const tools = [{
        name: "count_notes", description: "count lines in notes.txt",
        executionMode: "concurrent", timeoutMs: 5000,
        async execute() {
          const text = readFileSync(${JSON.stringify(dataFile)}, "utf8");
          const lines = text.split("\\n").filter(Boolean);
          return { content: "noted: " + lines.length + " lines (" + lines.join(", ") + ")" };
        },
      }];`,
    );
    expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
    expect(installPlugin(workspace, "m/io", "user").ok).toBe(true);

    const assembled = await assemblePluginRuntime(workspace, "tui");
    expect(assembled.warnings).toEqual([]);

    const store = createInMemorySessionStore();
    await store.create({
      sessionId: "io-e2e",
      backendKind: "oma",
      workspaceRoot: workspace,
      leafEntryId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    let turn = 0;
    const session = createOmaSession({
      sessionId: "io-e2e",
      store,
      plugins: assembled.plugins,
      maxSteps: 2,
      maxForceContinues: 0,
      summarize: async () => "s",
      modelStream: async function* (): AsyncIterable<AIMessageChunk> {
        turn++;
        if (turn === 1) {
          yield { delta: { type: "tool_use", id: "t1", name: "count_notes" } };
          yield { stopReason: "tool_use" };
        } else {
          yield { delta: { type: "text", text: "done" } };
        }
      },
    });
    await session.startLoop({
      input: { inputId: "in", message: { role: "user", text: "count notes" } },
      run: { runId: "r", model: { backendKind: "oma", modelId: "fake/echo" }, configRevision: 1 },
      workspace: { root: workspace, access: "read_write" },
    } as never);
    const snap = await store.open("io-e2e");
    expect(JSON.stringify(snap.entries)).toContain("noted: 3 lines (alpha, beta, gamma)");
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("plugin hooks entry really intercepts a NATIVE tool via beforeTool", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "oma-e2e-hooks-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-e2e-hooks-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  const marketRoot = join(workspace, "market");
  try {
    mkdirSync(join(marketRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(marketRoot, "marketplace.json"),
      JSON.stringify({ name: "m", plugins: [{ name: "hooks", path: "hooks" }] }),
    );
    writeFileSync(
      join(marketRoot, "hooks", "plugin.json"),
      JSON.stringify({ name: "hooks", hooks: "./hooks.ts" }),
    );
    // Real hooks: block the native bash tool whenever its command contains "rm -rf".
    writeFileSync(
      join(marketRoot, "hooks", "hooks.ts"),
      `export const hooks = {
        beforeTool(toolName: string, input: unknown) {
          if (toolName === "bash") {
            const command = (input as { command?: string })?.command ?? "";
            if (command.includes("rm -rf")) {
              return { block: true, reason: "hooks-e2e: rm -rf blocked by plugin hook" };
            }
          }
          return undefined;
        },
      };`,
    );
    expect(addMarketplace(workspace, marketRoot).ok).toBe(true);
    expect(installPlugin(workspace, "m/hooks", "user").ok).toBe(true);

    const assembled = await assemblePluginRuntime(workspace, "tui");
    expect(assembled.warnings).toEqual([]);
    // The hooks plugin exports no tools; only the hook is present.
    const hooksPlugin = assembled.plugins.find((p) => p.name === "plugin:hooks");
    expect(hooksPlugin?.hooks?.beforeTool).toBeDefined();

    const { createModelRuntime } = await import("@chengchenccc/ai");
    const { registerBuiltinProviders } = await import("../runtime/run-runtime.js");
    const { createOmaRuntime } = await import("../runtime/create-runtime.js");
    // Drive with the fake provider: first model call asks bash to run rm -rf.
    const savedFake = process.env.OMA_FAKE_PROVIDER;
    const savedTool = process.env.OMA_FAKE_TOOL;
    process.env.OMA_FAKE_PROVIDER = "1";
    process.env.OMA_FAKE_TOOL = JSON.stringify([
      { name: "bash", input: { command: "rm -rf /tmp/x", timeout: 1000 } },
    ]);
    try {
      const modelRuntime = createModelRuntime();
      registerBuiltinProviders(modelRuntime, process.env);
      const runtime = await createOmaRuntime({
        runId: "hooks-e2e",
        modelId: "fake/echo",
        workspaceRoot: workspace,
        workspaceAccess: "read_write",
        modelRuntime,
        skillRoots: [],
        pluginComponents: { plugins: assembled.plugins },
      });
      const seg = await runtime.run({
        input: { inputId: "in", message: { role: "user", text: "run rm" } },
        run: {
          runId: "hooks-e2e",
          model: { backendKind: "oma", modelId: "fake/echo" },
          configRevision: 1,
        },
        workspace: { root: workspace, access: "read_write" },
      } as never);
      const out = await seg.outcome;
      await runtime.close();
      const raw = JSON.stringify(out.messages ?? []);
      expect(raw).toContain("hooks-e2e: rm -rf blocked by plugin hook");
      // The hook blocked bash BEFORE execution — no bash output.
      expect(raw).not.toContain('"stdout"');
    } finally {
      if (savedFake === undefined) delete process.env.OMA_FAKE_PROVIDER;
      else process.env.OMA_FAKE_PROVIDER = savedFake;
      if (savedTool === undefined) delete process.env.OMA_FAKE_TOOL;
      else process.env.OMA_FAKE_TOOL = savedTool;
    }
  } finally {
    delete process.env.OMA_CODING_AGENT_DIR;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});
