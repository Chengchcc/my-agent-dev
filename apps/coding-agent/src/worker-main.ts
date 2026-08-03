import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import type { AgentLoopListener, CodingAgentLoopEvent } from "@my-agent-team/agent";
import type { AgentRunSnapshot, ProjectedHistoryItem } from "@my-agent-team/agent-backend";
import { createModelRuntime, type ModelRuntime } from "@my-agent-team/ai";
import {
  parseCommand,
  type SendCommand,
  type StartRunCommand,
  serializeMessage,
  type WorkerCommand,
} from "./worker-protocol.js";
import { assembleWorkerRuntime, type WorkerRuntime } from "./worker-runtime.js";

/** Daemon-spawned Worker entry: reads NDJSON commands on stdin, emits
 *  protocol NDJSON on stdout only, logs to stderr. Exactly one session. */

export interface WorkerMainOptions {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Injectable for tests. */
  runtimeFactory?: (opts: {
    dataDir: string;
    workspaceRoot: string;
    backendSessionId: string;
    modelRuntime: ModelRuntime;
  }) => WorkerRuntime;
}

function log(stderr: NodeJS.WritableStream, msg: string): void {
  stderr.write(`[worker] ${msg}\n`);
}

export async function runWorkerMain(opts: WorkerMainOptions): Promise<number> {
  const { stdin: inStream, stdout: outStream, stderr: errStream } = opts;
  let runtime: WorkerRuntime | null = null;
  let closed = false;
  let currentRunId: string | null = null;
  let runTerminalStatus: "completed" | "failed" | "stopped" = "completed";

  const send = (msg: Parameters<typeof serializeMessage>[0]): void => {
    outStream.write(serializeMessage(msg));
  };

  function emitEvent(event: CodingAgentLoopEvent): void {
    if (!runtime || !currentRunId) return;
    send({
      protocolVersion: 1,
      type: "event",
      backendSessionId: runtime.sessionId,
      runId: currentRunId,
      event: event as unknown as Record<string, unknown>,
    });
  }

  const listener: AgentLoopListener = async (event) => {
    if (event.type === "agent_end") {
      runTerminalStatus = event.status;
    }
    emitEvent(event);
  };

  async function handleCommand(cmd: WorkerCommand): Promise<void> {
    if (closed) return;
    switch (cmd.type) {
      case "open_session": {
        const modelRuntime = createModelRuntime();
        runtime = opts.runtimeFactory
          ? opts.runtimeFactory({
              dataDir: cmd.dataDir,
              workspaceRoot: cmd.workspaceRoot,
              backendSessionId: cmd.backendSessionId,
              modelRuntime,
            })
          : await assembleWorkerRuntime({
              dataDir: cmd.dataDir,
              workspaceRoot: cmd.workspaceRoot,
              backendSessionId: cmd.backendSessionId,
              modelRuntime,
              skillRoots: [],
            });
        runtime.session.onEvent(listener);
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
        });
        break;
      }

      case "start_run":
      case "send": {
        if (!runtime) throw new Error("session not open");
        const runCmd = cmd as StartRunCommand | SendCommand;
        runtime.setActiveRun(runCmd.run as AgentRunSnapshot<"coding_agent">);
        currentRunId = runCmd.runId;

        // steer: append only a steer input to the current active loop
        if (runCmd.mode === "steer") {
          runtime.session.steer(runCmd.promptText);
          send({
            protocolVersion: 1,
            type: "command_accepted",
            commandId: cmd.commandId,
            backendSessionId: cmd.backendSessionId,
            runId: runCmd.runId,
          });
          break;
        }

        const history = (runCmd.type === "start_run"
          ? runCmd.history
          : runCmd.messages) as unknown as readonly ProjectedHistoryItem[];
        const metaText =
          "metaText" in runCmd && runCmd.metaText ? runCmd.metaText : `[run ${runCmd.runId}]`;
        const deps = {
          systemPrompt: runCmd.systemPrompt ?? "",
          metaText,
          promptText: runCmd.promptText,
          history,
        };
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
          runId: runCmd.runId,
        });
        // Run the loop; outcome emitted after listeners settle (agent_end)
        if (runCmd.type === "start_run") {
          await runtime.session.startLoop(deps);
        } else {
          await runtime.session.startFollowUp(deps);
        }
        // Exactly one terminal outcome per run, derived from agent_end status
        send({
          protocolVersion: 1,
          type: "outcome",
          backendSessionId: cmd.backendSessionId,
          runId: runCmd.runId,
          outcome:
            runTerminalStatus === "completed"
              ? { status: "completed" }
              : runTerminalStatus === "stopped"
                ? { status: "aborted", error: "stopped by user" }
                : { status: "failed", error: "loop failed" },
        });
        currentRunId = null;
        break;
      }

      case "compact": {
        if (!runtime) throw new Error("session not open");
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
        });
        await runtime.session.compact();
        send({
          protocolVersion: 1,
          type: "command_result",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
          result: { compacted: true },
        });
        break;
      }

      case "stop_run": {
        if (!runtime) throw new Error("session not open");
        runtime.session.stop();
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
          runId: cmd.runId,
        });
        break;
      }

      case "close_session": {
        if (runtime) runtime.session.stop();
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
        });
        closed = true;
        break;
      }

      case "shutdown": {
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: cmd.backendSessionId,
        });
        closed = true;
        break;
      }
    }
  }

  const rl = createInterface({ input: inStream, terminal: false });
  rl.on("line", async (line) => {
    if (closed) return;
    try {
      const cmd = parseCommand(line);
      await handleCommand(cmd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(errStream, `command failed: ${message}`);
      send({
        protocolVersion: 1,
        type: "command_error",
        code: "command_failed",
        message,
      });
    }
  });
  await new Promise<void>((resolve) => {
    rl.on("close", () => resolve());
  });
  return 0;
}

// Direct execution: spawned as `bun src/worker-main.ts`
if (import.meta.main) {
  const exitCode = await runWorkerMain({ stdin, stdout, stderr: process.stderr });
  process.exit(exitCode);
}
