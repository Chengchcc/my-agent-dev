import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import type { AgentLoopListener, CodingAgentLoopEvent } from "@my-agent-team/agent";
import type {
  AgentRunSnapshot,
  BackendInputMessage,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "@my-agent-team/agent-backend";
import { createModelRuntime, type ModelRuntime } from "@my-agent-team/ai";
import type { Message } from "@my-agent-team/message";
import {
  parseCommand,
  type SendCommand,
  type StartRunCommand,
  serializeMessage,
  type WorkerCommand,
} from "./worker-protocol.js";
import { assembleWorkerRuntime, type WorkerRuntime } from "./worker-runtime.js";

/** Daemon-spawned Worker entry: reads NDJSON commands on stdin, emits
 *  protocol NDJSON on stdout only, logs to stderr. Exactly one session.
 *
 *  Command dispatch is serialized for lifecycle mutations (open/start/follow-up/
 *  compact/close) via a promise chain - readline does NOT await async line
 *  listeners, so without a chain multiple commands would interleave. steer and
 *  stop are control inputs delivered to the active loop immediately and do not
 *  wait on the chain. */

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
  }) => Promise<WorkerRuntime>;
}

function log(stderr: NodeJS.WritableStream, msg: string): void {
  stderr.write(`[worker] ${msg}\n`);
}

export async function runWorkerMain(opts: WorkerMainOptions): Promise<number> {
  const { stdin: inStream, stdout: outStream, stderr: errStream } = opts;
  let runtime: WorkerRuntime | null = null;
  let closed = false;
  let currentRunId: string | null = null;
  // Per-run accumulator for the terminal assistant Message (events carry text
  // deltas; the outcome must carry the canonical final output).
  let runAssistantText = "";
  let runTerminalStatus: "completed" | "failed" | "stopped" = "completed";
  // Session-level facts captured on the first start_run, reused by follow-ups.
  let sessionWorkspace: WorkspaceBinding | null = null;
  let sessionMetadata: {
    conversationId: string;
    agentMemberId: string;
    branchId: string;
    productRevision: number;
  } | null = null;

  const send = (msg: Parameters<typeof serializeMessage>[0]): void => {
    outStream.write(serializeMessage(msg));
  };

  function emitEvent(event: CodingAgentLoopEvent): void {
    if (!runtime || !currentRunId) return;
    if (event.type === "message_update") runAssistantText += event.text;
    send({
      protocolVersion: 1,
      type: "event",
      backendSessionId: runtime.sessionId,
      runId: currentRunId,
      event: event as unknown as Record<string, unknown>,
    });
  }

  const listener: AgentLoopListener = async (event) => {
    if (event.type === "agent_end") runTerminalStatus = event.status;
    emitEvent(event);
  };

  /** Build the CodingLoopInput the Session consumes. Meta is rendered by the
   *  Session internally (never crosses this boundary). */
  function buildLoopInput(
    cmd: StartRunCommand | SendCommand,
    history: readonly ProjectedHistoryItem[],
    input: BackendInputMessage,
    mode: "normal" | "follow_up",
  ) {
    const workspace: WorkspaceBinding =
      cmd.type === "start_run"
        ? cmd.workspace
        : (sessionWorkspace ?? { root: process.cwd(), access: "read_write" });
    const metadata =
      cmd.type === "start_run"
        ? cmd.metadata
        : (sessionMetadata ?? {
            conversationId: "",
            agentMemberId: "",
            branchId: "",
            productRevision: 0,
          });
    if (cmd.type === "start_run") {
      sessionWorkspace = cmd.workspace;
      sessionMetadata = cmd.metadata;
    }
    return {
      history,
      input,
      run: cmd.run as AgentRunSnapshot<"coding_agent">,
      workspace,
      metadata,
      mode,
    };
  }

  async function handleCommand(cmd: WorkerCommand): Promise<void> {
    if (closed) return;
    switch (cmd.type) {
      case "open_session": {
        const modelRuntime = createModelRuntime();
        // Register built-in providers from the daemon-injected env. The
        // Anthropic provider resolves ANTHROPIC_API_KEY per request; a fake
        // deterministic provider is available for integration tests.
        if (process.env.CODING_AGENT_FAKE_PROVIDER === "1") {
          const { fakeProvider } = await import("./fake-provider.js");
          modelRuntime.registerProvider(fakeProvider());
        } else if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
          const { anthropicProvider } = await import("@my-agent-team/ai");
          modelRuntime.registerProvider(anthropicProvider());
        }
        runtime = opts.runtimeFactory
          ? await opts.runtimeFactory({
              dataDir: cmd.dataDir,
              workspaceRoot: cmd.workspaceRoot,
              backendSessionId: cmd.backendSessionId,
              modelRuntime,
            })
          : await assembleWorkerRuntime({
              dataDir: cmd.dataDir,
              workspaceRoot: cmd.workspaceRoot,
              workspaceAccess: cmd.workspaceAccess,
              backendSessionId: cmd.backendSessionId,
              modelRuntime,
              skillRoots: [],
            });
        runtime.session.onEvent(listener);
        // Create or reopen the durable session file before any run.
        try {
          await runtime.store.open(cmd.backendSessionId);
        } catch {
          await runtime.store.create({
            sessionId: cmd.backendSessionId,
            backendKind: "coding_agent",
            workspaceRoot: cmd.workspaceRoot,
            leafEntryId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
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
        runtime.setActiveRun(cmd.run as AgentRunSnapshot<"coding_agent">);
        currentRunId = cmd.runId;
        runAssistantText = "";

        // Steer is a control input: deliver to the active loop immediately,
        // no new Loop, no Meta, no acceptance of a new run.
        if (cmd.type === "send" && cmd.mode === "steer") {
          runtime.session.steer(cmd.input as unknown as BackendInputMessage);
          send({
            protocolVersion: 1,
            type: "command_accepted",
            commandId: cmd.commandId,
            backendSessionId: runtime.sessionId,
            runId: cmd.runId,
          });
          break;
        }

        const mode: "normal" | "follow_up" =
          cmd.type === "start_run" ? "normal" : cmd.mode === "follow_up" ? "follow_up" : "normal";
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: runtime.sessionId,
          runId: cmd.runId,
        });

        const loopInput = buildLoopInput(
          cmd,
          cmd.history as unknown as readonly ProjectedHistoryItem[],
          cmd.input as unknown as BackendInputMessage,
          mode,
        );
        if (mode === "follow_up") {
          await runtime.session.startFollowUp(loopInput);
        } else {
          await runtime.session.startLoop(loopInput);
        }
        send({
          protocolVersion: 1,
          type: "outcome",
          backendSessionId: runtime.sessionId,
          runId: cmd.runId,
          outcome: buildOutcome() as never,
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
          backendSessionId: runtime.sessionId,
        });
        await runtime.session.compact();
        send({
          protocolVersion: 1,
          type: "command_result",
          commandId: cmd.commandId,
          backendSessionId: runtime.sessionId,
          result: { compacted: true },
        });
        break;
      }

      case "stop_run": {
        if (!runtime) throw new Error("session not open");
        // Control input: abort the active loop immediately.
        runtime.session.stop();
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: runtime.sessionId,
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
          backendSessionId: runtime?.sessionId ?? cmd.backendSessionId,
        });
        closed = true;
        break;
      }

      case "shutdown": {
        send({
          protocolVersion: 1,
          type: "command_accepted",
          commandId: cmd.commandId,
          backendSessionId: runtime?.sessionId ?? cmd.backendSessionId,
        });
        closed = true;
        break;
      }
    }
  }

  /** Build the terminal outcome from the run's accumulated state. The final
   *  assistant Message is the canonical output (Phase 4 terminal commit). */
  function buildOutcome():
    | { status: "completed"; output: Message }
    | { status: "aborted"; error: string }
    | { status: "failed"; error: string } {
    if (runTerminalStatus === "completed") {
      return {
        status: "completed",
        output: { role: "assistant", text: runAssistantText },
      };
    }
    if (runTerminalStatus === "stopped") {
      return { status: "aborted", error: "stopped by user" };
    }
    return { status: "failed", error: "loop failed" };
  }

  // Serialize lifecycle commands: readline does not await async listeners, so a
  // bare `await handleCommand` would let the next command interleave. steer and
  // stop are dispatched ahead of the chain as control inputs.
  let chain: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: inStream, terminal: false });
  rl.on("line", (line) => {
    if (closed) return;
    try {
      const cmd = parseCommand(line);
      // Control inputs bypass the lifecycle chain.
      const isControl = (cmd.type === "send" && cmd.mode === "steer") || cmd.type === "stop_run";
      if (isControl) {
        void handleCommand(cmd).catch((err) => reportError(cmd.commandId ?? "", err));
        return;
      }
      chain = chain
        .then(() => handleCommand(cmd))
        .catch((err) => reportError((cmd as { commandId?: string }).commandId ?? "", err));
    } catch (err) {
      reportError("", err);
    }
  });

  function reportError(commandId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    log(errStream, `command failed: ${message}`);
    send({
      protocolVersion: 1,
      type: "command_error",
      commandId: commandId || undefined,
      backendSessionId: runtime?.sessionId,
      code: "command_failed",
      message,
    });
  }

  await new Promise<void>((resolve) => {
    rl.on("close", () => {
      // Let the serialized command chain drain before exiting so a fast
      // stdin close (tests) does not truncate in-flight commands.
      chain.finally(() => resolve());
    });
  });
  return 0;
}

// Direct execution: spawned as `bun src/worker-main.ts`
if (import.meta.main) {
  runWorkerMain({ stdin, stdout, stderr }).then((code) => process.exit(code));
}
