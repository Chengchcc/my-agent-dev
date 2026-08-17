import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAIN = new URL("../src/cli.ts", import.meta.url).pathname;
const OUT = new URL("../fixtures/rpc-basic.jsonl", import.meta.url).pathname;

const EXECUTE = {
  id: "e1",
  type: "execute",
  input: {
    input: { inputId: "in-1", message: { role: "user", text: "go" } },
    run: {
      runId: "r-fixture-1",
      model: { backendKind: "oma", modelId: "fake/echo" },
      configRevision: 1,
    },
    workspace: { root: process.cwd(), access: "read_write" },
    metadata: { conversationId: "c-fixture", agentMemberId: "m-fixture", branchId: "b-fixture" },
  },
};

const proc = Bun.spawn({
  cmd: [process.execPath, MAIN, "--mode", "rpc"],
  cwd: process.cwd(),
  env: { ...process.env, OMA_FAKE_PROVIDER: "1" },
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
proc.stdin!.write(`${JSON.stringify(EXECUTE)}\n`);
const stdout = await new Response(proc.stdout).text();
const exitCode = await proc.exited;
if (exitCode !== 0) {
  const stderr = await new Response(proc.stderr).text();
  throw new Error(`fixture child exited ${exitCode}: ${stderr}`);
}
mkdirSync(new URL("../fixtures/", import.meta.url).pathname, { recursive: true });
writeFileSync(OUT, stdout);
console.log(`wrote ${join(process.cwd(), "fixtures", "rpc-basic.jsonl")}`);
