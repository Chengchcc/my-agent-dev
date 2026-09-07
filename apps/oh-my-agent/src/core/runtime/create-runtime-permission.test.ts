import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";

const { tmp, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);
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
  // Model calls the mounted MCP tool by its qualified mcp__ name; the echo
  // fixture (via .mcp.json) answers (content "ok:todo_write") and no
  // .oma/todo.json is written — the call never reaches native todo.
  process.env.OMA_FAKE_TOOL = JSON.stringify([
    { name: "mcp__echo-server__todo_write", input: { items: [] } },
  ]);
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
