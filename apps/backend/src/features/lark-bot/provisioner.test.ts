import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSetupProvisioner } from "./provisioner.js";

const SETUP_URL = "https://open.feishu.cn/setup?token=abc123";
const ORIG_PATH = process.env.PATH;
const fakeBins: string[] = [];

/** Create a fake `lark-cli` on PATH that prints the setup URL to the given
 *  stream and exits after `delayMs`. Real spawn: the piped stdout/stderr
 *  behavior is exactly what the provisioner sees in production. */
function installFakeCli(opts: {
  stream: "stdout" | "stderr";
  delayMs?: number;
  exitCode?: number;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "lark-cli-fake-"));
  fakeBins.push(dir);
  const redir = opts.stream === "stderr" ? ">&2" : ">&1";
  const sleep = opts.delayMs ? `sleep ${opts.delayMs / 1000}` : "";
  const bin = join(dir, "lark-cli");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
printf '%s\\n' '${SETUP_URL}' ${redir}
${sleep}
exit ${opts.exitCode ?? 0}
`,
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${dir}:${ORIG_PATH}`;
  return dir;
}

afterAll(() => {
  process.env.PATH = ORIG_PATH;
  for (const dir of fakeBins) rmSync(dir, { recursive: true, force: true });
});

describe("CliSetupProvisioner URL capture", () => {
  test("URL on stderr (piped stdout) is streamed via onUrl before exit", async () => {
    installFakeCli({ stream: "stderr", delayMs: 300 });
    const provisioner = new CliSetupProvisioner();
    const urls: string[] = [];
    const result = await provisioner.start({
      agentId: "ag-1",
      profileRef: "agent:ag-1",
      brand: "feishu",
      timeoutMs: 5_000,
      onUrl: (url) => urls.push(url),
    });

    await Bun.sleep(100);
    expect(urls).toEqual([SETUP_URL]); // streamed while the child is still alive
    await expect(result.waitForCompletion).resolves.toBe(SETUP_URL);
  });

  test("URL on stdout still resolved via onUrl", async () => {
    installFakeCli({ stream: "stdout", delayMs: 300 });
    const provisioner = new CliSetupProvisioner();
    const urls: string[] = [];
    const result = await provisioner.start({
      agentId: "ag-1",
      profileRef: "agent:ag-1",
      brand: "lark",
      timeoutMs: 5_000,
      onUrl: (url) => urls.push(url),
    });

    await Bun.sleep(100);
    expect(urls).toEqual([SETUP_URL]);
    await expect(result.waitForCompletion).resolves.toBe(SETUP_URL);
  });

  test("without onUrl, exit handler still resolves the URL from the combined buffer", async () => {
    installFakeCli({ stream: "stderr", delayMs: 50 });
    const provisioner = new CliSetupProvisioner();
    const result = await provisioner.start({
      agentId: "ag-1",
      profileRef: "agent:ag-1",
      brand: "feishu",
      timeoutMs: 5_000,
    });

    await expect(result.waitForCompletion).resolves.toBe(SETUP_URL);
  });

  test("missing lark-cli rejects with a clear error (no silent hang)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-cli-empty-"));
    fakeBins.push(dir);
    process.env.PATH = dir; // no lark-cli on PATH
    const provisioner = new CliSetupProvisioner();
    const result = await provisioner.start({
      agentId: "ag-1",
      profileRef: "agent:ag-1",
      brand: "feishu",
      timeoutMs: 5_000,
    });

    await expect(result.waitForCompletion).rejects.toThrow(/lark-cli not found/);
  });
});
