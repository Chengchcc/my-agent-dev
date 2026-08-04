import { stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import type {
  AgentLoopListener,
  CodingAgentLoopEvent,
  CodingAgentLoopResult,
} from "@my-agent-team/agent";
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
import {
  assembleWorkerRuntime,
  registerBuiltinProviders,
  type WorkerRuntime,
} from "./worker-runtime.js";

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
  // Set once the readline exists; close_session/shutdown call it so the
  // process actually exits (readline close -> chain drains -> main returns).
  let closeRl: (() => void) | null = null;
  let currentRunId: string | null = null;
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
    send({
      protocolVersion: 1,
      type: "event",
      backendSessionId: runtime.sessionId,
      runId: currentRunId,
      event: event as unknown as Record<string, unknown>,
    });
  }

  const listener: AgentLoopListener = async (event) => {
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
    let metadata: {
      conversationId: string;
      agentMemberId: string;
      branchId: string;
      productRevision: number;
    };
    if (cmd.type === "start_run") {
      metadata = cmd.metadata;
      sessionWorkspace = cmd.workspace;
      sessionMetadata = cmd.metadata;
    } else {
      // Follow-up/steer: conversation + agentMember inherit the session;
      // branchId + productRevision come from the CURRENT send (a fork or
      // branch change must take effect, and Product Tool identity uses it).
      const current = cmd.metadata;
      metadata = {
        conversationId: sessionMetadata?.conversationId ?? "",
        agentMemberId: sessionMetadata?.agentMemberId ?? "",
        branchId: current?.branchId ?? sessionMetadata?.branchId ?? "",
        productRevision: current?.productRevision ?? sessionMetadata?.productRevision ?? 0,
      };
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
        // Same provider assembly as the daemon catalog (single source of truth).
        registerBuiltinProviders(modelRuntime);
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
              productTools: cmd.productTools as never,
              productIdentity: cmd.identity as never,
            });
        runtime.session.onEvent(listener);
        // Exactly one open_session per Worker: a second one with a different
        // backendSessionId is an identity violation, not a session switch.
        if (runtime.sessionId !== cmd.backendSessionId) {
          throw new Error(
            `open_session identity mismatch: worker is ${runtime.sessionId}, got ${cmd.backendSessionId}`,
          );
        }
        // Create or reopen the durable session file before any run. Only a
        // genuine not-found creates; corruption/permission errors must NOT be
        // misread as "missing" (they propagate as command_error).
        try {
          await runtime.store.open(cmd.backendSessionId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/not found/i.test(message)) throw err;
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
        // Steer is a control input into the ACTIVE loop: it must not touch
        // setActiveRun/currentRunId (its runId names the active run, not a new
        // one), otherwise subsequent active-loop events would be mislabeled.
        if (cmd.type === "send" && cmd.mode === "steer") {
          runtime.session.steer(cmd.input as unknown as BackendInputMessage);
          send({
            protocolVersion: 1,
            type: "command_accepted",
            commandId: cmd.commandId,
            backendSessionId: runtime.sessionId,
            runId: currentRunId ?? cmd.runId,
          });
          break;
        }
        runtime.setActiveRun(cmd.run as AgentRunSnapshot<"coding_agent">);
        currentRunId = cmd.runId;

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
        const result =
          mode === "follow_up"
            ? await runtime.session.startFollowUp(loopInput)
            : await runtime.session.startLoop(loopInput);
        send({
          protocolVersion: 1,
          type: "outcome",
          backendSessionId: runtime.sessionId,
          runId: cmd.runId,
          outcome: mapLoopResult(result) as never,
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
        if (runtime) await runtime.close();
        // Actually exit: close the readline (stdin) so the process terminates
        // and the Supervisor's awaited handle.exited resolves - the session
        // file is then safe to delete or reopen.
        closeRl?.();
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
        if (runtime) await runtime.close();
        closeRl?.();
        break;
      }
    }
  }

  /** Map the canonical CodingAgentLoopResult to the wire outcome. The output
   *  Message is the persisted assistant entry (blocks intact); error is the
   *  redacted terminal reason - never a generic placeholder. */
  function mapLoopResult(
    result: CodingAgentLoopResult,
  ):
    | { status: "completed"; output?: Message; usage?: unknown }
    | { status: "aborted"; error: string }
    | { status: "failed"; error: string } {
    if (result.status === "completed") {
      // No fabricated output: when the loop persisted no canonical assistant
      // Message, omit it rather than inventing an empty one for Phase 4.
      return {
        status: "completed",
        ...(result.output ? { output: result.output } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      };
    }
    if (result.status === "stopped") {
      return { status: "aborted", error: result.error ?? "stopped by user" };
    }
    return { status: "failed", error: result.error ?? "loop failed" };
  }

  // Serialize lifecycle commands: readline does not await async listeners, so a
  // bare `await handleCommand` would let the next command interleave. steer and
  // stop are dispatched ahead of the chain as control inputs.
  let chain: Promise<void> = Promise.resolve();
  const rl = createInterface({ input: inStream, terminal: false });
  closeRl = () => rl.close();
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
