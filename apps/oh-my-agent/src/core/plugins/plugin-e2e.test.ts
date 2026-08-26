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
