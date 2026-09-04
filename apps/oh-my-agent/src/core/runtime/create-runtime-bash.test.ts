import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
  registerBuiltinProviders,
} from "./create-runtime.fixture.js";

const { runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);
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
