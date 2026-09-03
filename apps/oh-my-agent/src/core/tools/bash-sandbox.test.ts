import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "./bash.js";
import type { BashSpawn } from "./bash-sandbox.js";
import { BwrapBashSandbox, NullBashSandbox, resolveBashSandbox } from "./bash-sandbox.js";

const HAS_BWRAP = Bun.which("bwrap") !== null;

/** P1 acceptance (BashSandbox design): the injected launch strategy replaces
 * the hardcoded Bun.spawn, and the sandboxed flag reaches the approval wire.
 * Seatbelt/Bwrap implementations (P2/P3) must keep this test green unchanged. */

/** Recording double: implements BashSandbox so createBashTool routes through
 * it; proves the tool consumes the injected spawn (P1 wiring) without
 * depending on Null's behavior. */
function recordingSandbox(workspaceRoot: string, spawned: string[]) {
  const nullSandbox = new NullBashSandbox(workspaceRoot);
  return {
    workspaceRoot,
    spawn(
      command: string,
      opts: { cwd: string; env?: Readonly<Record<string, string>> },
    ): BashSpawn {
      spawned.push(`${command}@${opts.cwd}`);
      return nullSandbox.spawn(command, opts);
    },
  };
}

describe("bash tool + BashSandbox injection (P1)", () => {
  test("injected sandbox receives the spawn (not the hardcoded path)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "bash-sbx-"));
    const spawned: string[] = [];
    const tool = createBashTool({
      workspaceRoot: ws,
      sandbox: recordingSandbox(ws, spawned),
    });
    const out = await tool.execute({ description: "d", command: "echo sbx" });
    expect(spawned).toEqual([`echo sbx@${ws}`]);
    expect(String(out.content)).toContain("sbx");
  });

  test("default (no injection) still runs plain bash — zero-regression P1", async () => {
    const ws = mkdtempSync(join(tmpdir(), "bash-def-"));
    writeFileSync(join(ws, "marker.txt"), "ok");
    const tool = createBashTool({ workspaceRoot: ws });
    const out = await tool.execute({ description: "d", command: "cat marker.txt" });
    expect(String(out.content)).toContain("ok");
    expect(out.isError).toBeFalsy();
  });
});

// P3 acceptance: real bubblewrap runs, and the OS-enforced boundaries hold.
// Skipped when bwrap is absent (e.g. macOS dev machines) — the factory test
// below still pins the unavailability error.
(HAS_BWRAP ? describe : describe.skip)("BwrapBashSandbox (P3, requires bubblewrap)", () => {
  const run = async (command: string) => {
    const ws = mkdtempSync(join(tmpdir(), "bwrap-ws-"));
    const tool = createBashTool({ workspaceRoot: ws, sandbox: new BwrapBashSandbox(ws) });
    return { ws, out: await tool.execute({ description: "d", command }) };
  };

  test("workspace file write+read works inside the sandbox", async () => {
    const { out } = await run("echo hello > w.txt && cat w.txt");
    expect(String(out.content)).toContain("hello");
    expect(out.isError).toBeFalsy();
  });

  test("system tree is read-only (root fs write denied)", async () => {
    const { out } = await run(
      "touch /etc/bwrap-probe 2>/dev/null && echo WROTE-ROOT || echo root-ro",
    );
    expect(String(out.content)).toContain("root-ro");
  });

  test("network is blocked (--unshare-net)", async () => {
    // /dev/tcp needs no curl binary; bash builtin. Short timeout so a
    // misconfigured sandbox fails fast instead of hanging the suite.
    const { out } = await run(
      "timeout 3 bash -c 'echo x > /dev/tcp/1.1.1.1/80' 2>/dev/null && echo NET-OPEN || echo net-blocked",
    );
    expect(String(out.content)).toContain("net-blocked");
  });

  test("workspace under /tmp is not shadowed by the private tmpfs", async () => {
    // bwrap arg order probe (0.8): --tmpfs /tmp shadows earlier binds under
    // /tmp; the workspace bind must come after. Real workspace in tmpdir().
    const ws = mkdtempSync(join(tmpdir(), "bwrap-order-"));
    writeFileSync(join(ws, "f.txt"), "visible");
    const tool = createBashTool({ workspaceRoot: ws, sandbox: new BwrapBashSandbox(ws) });
    const out = await tool.execute({ description: "d", command: "cat f.txt" });
    expect(String(out.content)).toContain("visible");
  });
});

describe("resolveBashSandbox factory", () => {
  test("enabled=false → Null regardless of platform", () => {
    const ws = "/ws";
    expect(
      resolveBashSandbox({ workspaceRoot: ws, enabled: false, platform: "linux" }),
    ).toBeInstanceOf(NullBashSandbox);
  });

  test("linux + bwrap → Bwrap; linux without bwrap → explicit error (no silent unconstrained run)", () => {
    const ws = "/ws";
    if (HAS_BWRAP) {
      expect(
        resolveBashSandbox({ workspaceRoot: ws, enabled: true, platform: "linux" }),
      ).toBeInstanceOf(BwrapBashSandbox);
    } else {
      expect(() =>
        resolveBashSandbox({ workspaceRoot: ws, enabled: true, platform: "linux" }),
      ).toThrow(/bubblewrap is not installed/);
    }
  });

  test("unsupported platform → explicit error naming the phase", () => {
    expect(() =>
      resolveBashSandbox({ workspaceRoot: "/ws", enabled: true, platform: "darwin" }),
    ).toThrow(/not implemented for platform darwin/);
  });
});
