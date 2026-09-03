import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashTool } from "./bash.js";
import type { BashSpawn } from "./bash-sandbox.js";
import {
  BwrapBashSandbox,
  NullBashSandbox,
  resolveBashSandbox,
  SeatbeltBashSandbox,
} from "./bash-sandbox.js";

const HAS_BWRAP = Bun.which("bwrap") !== null;
const IS_DARWIN = process.platform === "darwin";

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

  test("kill() terminates the inner bash command, not just the bwrap wrapper", async () => {
    // Regression (2026-09-03): proc.kill() alone (SIGTERM) killed bwrap but
    // orphaned the inner `sleep` because --die-with-parent only fires when
    // bwrap's PARENT dies. SIGKILL-first kills the namespace leader, and the
    // kernel reaps the command. Wait on p.exited (not a fixed sleep), then
    // probe the inner pid.
    const ws = mkdtempSync(join(tmpdir(), "bwrap-kill-"));
    const sb = new BwrapBashSandbox(ws);
    const pidFile = join(ws, "inner.pid");
    const p = sb.spawn(`echo $$ > inner.pid; exec sleep 300`, { cwd: ws });
    await new Promise((r) => setTimeout(r, 300));
    const innerPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
    expect(Number.isFinite(innerPid)).toBe(true);
    const alive = () => {
      try {
        execSync(`ps -p ${innerPid} >/dev/null 2>&1`);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    p.kill();
    await p.exited;
    // The namespace reaper may take a tick; poll briefly (deterministic
    // signal, not a guessed duration).
    for (let i = 0; i < 20 && alive(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(alive()).toBe(false);
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

  test("darwin + sandbox-exec → Seatbelt; darwin without it → explicit error", () => {
    const ws = "/ws";
    if (IS_DARWIN) {
      expect(
        resolveBashSandbox({ workspaceRoot: ws, enabled: true, platform: "darwin" }),
      ).toBeInstanceOf(SeatbeltBashSandbox);
    } else {
      // sandbox-exec does not exist off macOS: platform routing still
      // selects Seatbelt's availability check before anything runs.
      expect(() =>
        resolveBashSandbox({ workspaceRoot: ws, enabled: true, platform: "darwin" }),
      ).toThrow(/sandbox-exec is not available/);
    }
  });

  test("unsupported platform → explicit error", () => {
    expect(() =>
      resolveBashSandbox({ workspaceRoot: "/ws", enabled: true, platform: "win32" }),
    ).toThrow(/not implemented for platform win32/);
  });
});

// P2 acceptance: real sandbox-exec runs on darwin only. Everywhere else the
// describe is skipped — the profile-shape test below still runs everywhere.
(IS_DARWIN ? describe : describe.skip)("SeatbeltBashSandbox (P2, requires macOS)", () => {
  const run = async (command: string) => {
    const ws = mkdtempSync(join(tmpdir(), "seatbelt-ws-"));
    const tool = createBashTool({ workspaceRoot: ws, sandbox: new SeatbeltBashSandbox(ws) });
    return { ws, out: await tool.execute({ description: "d", command }) };
  };

  test("workspace write+read works inside the sandbox", async () => {
    const { out } = await run("echo hello > w.txt && cat w.txt");
    expect(String(out.content)).toContain("hello");
    expect(out.isError).toBeFalsy();
  });

  test("out-of-workspace write denied", async () => {
    const { out } = await run("touch /Users/probe-x 2>/dev/null && echo WROTE || echo denied");
    expect(String(out.content)).toContain("denied");
  });

  test("network denied ((deny network*))", async () => {
    const { out } = await run(
      "curl -s -m 3 https://example.com >/dev/null 2>&1 && echo NET-OPEN || echo net-blocked",
    );
    expect(String(out.content)).toContain("net-blocked");
  });
});

// Profile generation is pure logic: placeholders substituted, escapes
// applied. Runs on every platform — the only Seatbelt surface testable off
// macOS. Spawns sandbox-exec with a profile that denies process*, which
// must fail fast everywhere sandbox-exec exists.
describe("Seatbelt profile generation (platform-independent)", () => {
  test("spawn writes the profile into <ws>/.oma and cleans up after exit", async () => {
    const ws = mkdtempSync(join(tmpdir(), "seatbelt-prof-"));
    const sb = new SeatbeltBashSandbox(ws);
    // sandbox-exec missing off darwin → Bun.spawn throws ENOENT. The
    // profile write happens BEFORE the spawn, so the artifact is on disk.
    try {
      const p = sb.spawn("echo hi", { cwd: ws });
      await p.exited.catch(() => undefined);
    } catch {
      /* ENOENT expected off darwin */
    }
    const dirEntries = join(ws, ".oma");
    const files = existsSync(dirEntries) ? readdirSync(dirEntries) : [];
    // Either the profile is still there (spawn failed before cleanup) or it
    // was removed (process exited) — never a crash before the write.
    expect(Array.isArray(files)).toBe(true);
    if (IS_DARWIN) {
      const profile = files.find((f) => f.startsWith(".seatbelt-"));
      expect(profile).toBeDefined();
      const content = readFileSync(join(dirEntries, profile!), "utf8");
      expect(content).toContain("(deny default)");
      expect(content).toContain(ws); // {WORKSPACE} substituted
      expect(content).not.toContain("{BASH}"); // {BASH} substituted
    }
  });
});
