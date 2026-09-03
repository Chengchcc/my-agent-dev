import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "./bash.js";
import type { BashSpawn } from "./bash-sandbox.js";
import { NullBashSandbox } from "./bash-sandbox.js";

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
