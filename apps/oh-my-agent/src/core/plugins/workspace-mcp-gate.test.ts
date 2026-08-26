import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime } from "@chengchenccc/ai";
import { createOmaRuntime } from "../runtime/create-runtime.js";
import { registerBuiltinProviders } from "../runtime/run-runtime.js";
import { assemblePluginRuntime } from "./plugin-resolve.js";
import { trustFile } from "./plugin-trust.js";

const ECHO_SERVER = join(import.meta.dir, "../__fixtures__/mcp-echo-server.ts");

function setup(): { workspace: string; agent: string } {
  const workspace = mkdtempSync(join(tmpdir(), "oma-mcpgate-ws-"));
  const agent = mkdtempSync(join(tmpdir(), "oma-mcpgate-agent-"));
  process.env.OMA_CODING_AGENT_DIR = agent;
  writeFileSync(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "echo-server": { command: "bun", args: [ECHO_SERVER] } },
    }),
  );
  return { workspace, agent };
}

describe("workspace .mcp.json standalone trust gate", () => {
  test("mode layer warns when untrusted; silent when trusted or absent", async () => {
    const { workspace, agent } = setup();
    try {
      const untrusted = await assemblePluginRuntime(workspace, "tui");
      expect(untrusted.warnings.join(" ")).toContain("/mcp trust");

      trustFile(join(workspace, ".mcp.json"));
      const trusted = await assemblePluginRuntime(workspace, "tui");
      expect(trusted.warnings.join(" ")).not.toContain("/mcp trust");

      // File content change re-untrusts (hash mismatch).
      writeFileSync(
        join(workspace, ".mcp.json"),
        JSON.stringify({ mcpServers: { gated2: { command: "echo" } } }),
      );
      const changed = await assemblePluginRuntime(workspace, "tui");
      expect(changed.warnings.join(" ")).toContain("/mcp trust");

      // No .mcp.json at all: no warning.
      rmSync(join(workspace, ".mcp.json"));
      const absent = await assemblePluginRuntime(workspace, "tui");
      expect(absent.warnings.join(" ")).not.toContain("/mcp trust");
    } finally {
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });

  test("gateWorkspaceMcp skips mounting untrusted workspace servers; trusted mounts", async () => {
    const { workspace, agent } = setup();
    try {
      // Untrusted: the run mounts nothing from the workspace file. The fake
      // provider records the advertised tool table; the echo server tool
      // (mcp__echo-server__echo) must be absent.
      const record = join(agent, "mcpgate-tools.json");
      process.env.OMA_FAKE_PROVIDER = "1";
      process.env.OMA_FAKE_TOOLS_RECORD = record;
      const mr = createModelRuntime();
      registerBuiltinProviders(mr, process.env);
      const rt = await createOmaRuntime({
        runId: "r-gate",
        modelId: "fake/echo",
        workspaceRoot: workspace,
        workspaceAccess: "read_write",
        modelRuntime: mr,
        skillRoots: [],
        gateWorkspaceMcp: true,
      });
      const seg = await rt.run({
        input: { inputId: "in", message: { role: "user", text: "go" } },
        run: {
          runId: "r-gate",
          model: { backendKind: "oma", modelId: "fake/echo" },
          configRevision: 1,
        },
        workspace: { root: workspace, access: "read_write" },
      });
      const out = await seg.outcome;
      await rt.close();
      expect(out.status).toBe("completed");
      expect(await Bun.file(record).text()).not.toContain('"echo"');

      // Trusted: server mounts (record now contains the mounted tool names).
      trustFile(join(workspace, ".mcp.json"));
      const record2 = join(agent, "mcpgate-tools2.json");
      process.env.OMA_FAKE_TOOLS_RECORD = record2;
      const mr2 = createModelRuntime();
      registerBuiltinProviders(mr2, process.env);
      const rt2 = await createOmaRuntime({
        runId: "r-gate-2",
        modelId: "fake/echo",
        workspaceRoot: workspace,
        workspaceAccess: "read_write",
        modelRuntime: mr2,
        skillRoots: [],
        gateWorkspaceMcp: true,
      });
      const seg2 = await rt2.run({
        input: { inputId: "in2", message: { role: "user", text: "go" } },
        run: {
          runId: "r-gate-2",
          model: { backendKind: "oma", modelId: "fake/echo" },
          configRevision: 1,
        },
        workspace: { root: workspace, access: "read_write" },
      });
      const out2 = await seg2.outcome;
      await rt2.close();
      expect(out2.status).toBe("completed");
      const table2 = await Bun.file(record2).text();
      expect(table2).toContain(`"echo"`);
    } finally {
      delete process.env.OMA_FAKE_PROVIDER;
      delete process.env.OMA_FAKE_TOOLS_RECORD;
      delete process.env.OMA_CODING_AGENT_DIR;
      rmSync(workspace, { recursive: true, force: true });
      rmSync(agent, { recursive: true, force: true });
    }
  });
});
