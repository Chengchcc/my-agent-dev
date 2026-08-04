import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { exit, stdin, stdout } from "node:process";

/** Supervisor worker fixture for the same-supervisor crash-isolation test.
 *
 *  Forwards the protocol verbatim to the REAL worker (worker-main.ts), so a
 *  healthy session is a genuine worker. When a start_run names a workspace
 *  whose root ends with the `/crash-ws` marker, the proxy accepts the command
 *  ITSELF and then exits - the exact "Worker sent command_accepted, then died
 *  before any outcome" window. One supervisor hosts both sessions: the crash
 *  must fail only A's run while B's real worker continues. */

const workerMain = new URL("../worker-main.ts", import.meta.url).pathname;
const child = spawn(process.execPath, [workerMain], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const rl = createInterface({ input: stdin, terminal: false });
rl.on("line", (line) => {
  try {
    const cmd = JSON.parse(line);
    if (
      cmd.type === "start_run" &&
      typeof cmd.workspace?.root === "string" &&
      cmd.workspace.root.endsWith("/crash-ws")
    ) {
      // Accept, then die mid-run (no outcome). The child never sees this run.
      stdout.write(
        `${JSON.stringify({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
          runId: cmd.runId,
        })}\n`,
      );
      child.kill("SIGKILL");
      exit(3);
      return;
    }
  } catch {
    /* forwarded below */
  }
  child.stdin.write(`${line}\n`);
});

child.stdout.on("data", (chunk) => stdout.write(chunk));
child.on("exit", (code) => exit(code ?? 0));
child.on("error", () => exit(2));
