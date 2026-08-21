import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelRuntime, type Provider } from "@chengchenccc/ai";
import { buildCliRunInput } from "../cli/initial-input.js";
import { createOmaRuntime } from "./create-runtime.js";

/** A stdio MCP-ish server that spawns a GRANDCHILD holding the pipe open:
 *  the SDK's direct-child kill alone would leave the grandchild lingering
 *  and keep the oma process alive via the inherited stdio pipes. */
const SERVER = `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: ["inherit","inherit","inherit"] });
process.stdin.on("data", () => {});
setInterval(()=>{},1000);
`;

describe("product-tool stdio teardown", () => {
  test("closing the runtime kills the whole descendant process tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-pt-teardown-"));
    mkdirSync(join(dir, ".oma"), { recursive: true });
    writeFileSync(
      join(dir, ".oma", "product-tools.json"),
      JSON.stringify({
        tools: [{ name: "echo", entrypoint: "stdio:node", arguments: { script: SERVER } }],
      }),
    );
    const provider: Provider = {
      id: "probe",
      name: "Probe",
      getModels: () => [
        {
          id: "m",
          name: "M",
          provider: "probe",
          api: "anthropic-messages",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 8192,
        },
      ],
      async *stream(_model, messages) {
        const toolUsed = messages.some((m) => m.role === "tool");
        if (!toolUsed) {
          yield { delta: { type: "tool_use", id: "t1", name: "echo" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "t1",
              partial_json: JSON.stringify({ script: SERVER }),
            },
          };
          yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
          yield { stopReason: "tool_use" };
          return;
        }
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    };
    const rt = createModelRuntime();
    rt.registerProvider(provider);
    process.env.OMA_PRODUCT_TOOL_TIMEOUT_MS = "5000";
    try {
      const built = await buildCliRunInput({
        prompt: "use tool",
        workspaceRoot: dir,
        modelRuntime: rt,
      });
      const runtime = await createOmaRuntime({
        runId: "pt-teardown",
        modelId: built.run.model.modelId,
        workspaceRoot: dir,
        workspaceAccess: "read_write",
        modelRuntime: rt,
        skillRoots: [],
      });
      const segment = await runtime.run(built);
      const outcome = await segment.outcome;
      await runtime.close().catch(() => {});
      expect(outcome.status).toBe("completed");
      // Give reparenting a beat, then assert no grandchild survives.
      await new Promise((r) => setTimeout(r, 500));
      const left = Bun.spawnSync(["pgrep", "-f", "setInterval(()=>{},1000)"], {
        stdout: "pipe",
      })
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(left).toHaveLength(0);
    } finally {
      delete process.env.OMA_PRODUCT_TOOL_TIMEOUT_MS;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
