import { existsSync, statSync } from "node:fs";
import type {
  AbortCommand,
  BackendRunOutcome,
  CodingAgentCommand,
  CodingAgentOutput,
  ExecuteCommand,
  SteerCommand,
} from "@my-agent-team/agent-backend";
import {
  codingAgentCommandSchema,
  eventOutputSchema,
  outcomeOutputSchema,
  responseOutputSchema,
} from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";
import { type CodingAgentRuntime, createCodingAgentRuntime } from "../../core/create-runtime.js";
import { createJsonlReader } from "./jsonl.js";

/** Minimal RPC mode: stdin JSONL commands, stdout JSONL outputs only, stderr
 *  for logs. One process = at most one execute = one Run = one outcome, then
 *  the process exits. No Session lifecycle, no HTTP, no registry. */

export interface RpcModeOptions {
  modelRuntime: ModelRuntime;
  stdin?: ReadableStream<Uint8Array>;
  /** stdout writer; the RPC mode ONLY writes JSONL lines here. */
  writeLine?: (line: string) => void;
  log?: (line: string) => void;
}

export interface RpcModeController {
  readonly promise: Promise<number>;
  /** Abort the live Run (SIGINT/SIGTERM path): outcome settles aborted. */
  stop(): void;
}

function redactError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function runRpcMode(opts: RpcModeOptions): RpcModeController {
  const stdin = opts.stdin ?? Bun.stdin.stream();
  const write = opts.writeLine ?? ((line: string) => process.stdout.write(line));
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  // Serialized output: whole lines, in order, never interleaved.
  let writeChain: Promise<void> = Promise.resolve();
  const emit = (output: CodingAgentOutput): void => {
    const line = JSON.stringify(output);
    writeChain = writeChain.then(() => {
      write(`${line}\n`);
    });
  };
  const emitResponse = (
    id: string,
    command: CodingAgentCommand["type"],
    success: boolean,
    error?: string,
  ): void => {
    emit(
      responseOutputSchema.parse({
        id,
        type: "response",
        command,
        success,
        ...(success ? {} : { error: error ?? "command failed" }),
      }),
    );
  };

  let runtime: CodingAgentRuntime | null = null;
  let currentRunId: string | null = null;
  let executed = false;
  let finished = false;

  const promise = (async (): Promise<number> => {
    try {
      for await (const line of createJsonlReader(stdin)) {
        if (finished) {
          // The Run settled: the process exits. One more line is read so a
          // protocol-violating second execute gets an explicit rejection;
          // anything else (or EOF) just ends the process.
          if (line.trim()) {
            try {
              const command = codingAgentCommandSchema.parse(JSON.parse(line));
              if (command.type === "execute") {
                emitResponse(
                  command.id,
                  "execute",
                  false,
                  "a process accepts at most one execute command",
                );
              }
            } catch {
              /* ignored: the process is exiting */
            }
          }
          break;
        }
        if (!line.trim()) continue;
        let command: CodingAgentCommand;
        try {
          command = codingAgentCommandSchema.parse(JSON.parse(line));
        } catch {
          // Malformed JSON: a failure response keeps the protocol clean; the
          // peer settles the Run failed on an uncorrelated response.
          log(`malformed command (${line.length} bytes)`);
          emit(
            responseOutputSchema.parse({
              id: "",
              type: "response",
              command: "execute",
              success: false,
              error: "malformed JSON command",
            }),
          );
          continue;
        }
        switch (command.type) {
          case "execute": {
            if (executed) {
              // Protocol invariant: one process → at most one execute.
              emitResponse(
                command.id,
                "execute",
                false,
                "a process accepts at most one execute command",
              );
              break;
            }
            executed = true; // consumed synchronously: no double-execute race
            // Acceptance is AWAITED so the success response is always the
            // first output; the loop itself runs concurrently below so
            // steer/abort written after acceptance stay routable.
            await acceptExecute(command);
            break;
          }
          case "steer":
            handleSteer(command);
            break;
          case "abort":
            handleAbort(command);
            break;
        }
      }
      if (!finished) {
        log(`stdin closed before an outcome was produced (executed=${executed})`);
        return 1;
      }
      return await writeChain.then(() => 0);
    } catch (err) {
      log(`rpc mode failed: ${redactError(err)}`);
      return 1;
    }
  })();

  /** Validate + assemble the Runtime and emit the execute response. Awaited
   *  by the reader so the acceptance response is always the first output;
   *  the loop itself runs CONCURRENTLY via driveRun, keeping steer/abort
   *  routable for the whole run. */
  async function acceptExecute(command: ExecuteCommand): Promise<void> {
    const input = command.input;
    const err = await validateExecute(input, opts.modelRuntime);
    if (err) {
      emitResponse(command.id, "execute", false, err);
      return;
    }
    const runId = input.run.runId;
    try {
      runtime = await createCodingAgentRuntime({
        runId,
        workspaceRoot: input.workspace.root,
        workspaceAccess: input.workspace.access,
        modelRuntime: opts.modelRuntime,
        skillRoots: input.run.skillRoots ?? [],
        onEvent: (event) => {
          if (!finished) emit(eventOutputSchema.parse({ type: "event", runId, event }));
        },
      });
    } catch (caught) {
      emitResponse(command.id, "execute", false, `runtime assembly failed: ${redactError(caught)}`);
      return;
    }

    // Acceptance: the runtime is assembled, event forwarding is registered,
    // and steer/abort now route to it.
    currentRunId = runId;
    emitResponse(command.id, "execute", true, undefined);
    void driveRun(runtime, input);
  }

  /** Run the loop to its outcome, emit the outcome envelope, then finish. */
  async function driveRun(
    runtime: CodingAgentRuntime,
    input: ExecuteCommand["input"],
  ): Promise<void> {
    const runId = input.run.runId;
    let outcome: BackendRunOutcome;
    try {
      const segment = await runtime.run(input as never);
      outcome = await segment.outcome;
    } catch (caught) {
      outcome = { status: "failed", error: redactError(caught) };
    }
    finished = true;
    await runtime.close().catch(() => {});
    emit(outcomeOutputSchema.parse({ type: "outcome", runId, outcome }));
    await writeChain;
  }

  function handleSteer(command: SteerCommand): void {
    if (!executed || command.runId !== currentRunId || !runtime) {
      emitResponse(
        command.id,
        "steer",
        false,
        `no live run for runId: ${command.runId} (current: ${currentRunId ?? "none"})`,
      );
      return;
    }
    try {
      void runtime.steer(command.input as never).then(
        () => emitResponse(command.id, "steer", true),
        (err: unknown) => emitResponse(command.id, "steer", false, redactError(err)),
      );
    } catch (caught) {
      emitResponse(command.id, "steer", false, redactError(caught));
    }
  }

  function handleAbort(command: AbortCommand): void {
    if (!executed || command.runId !== currentRunId || !runtime) {
      emitResponse(
        command.id,
        "abort",
        false,
        `no live run for runId: ${command.runId} (current: ${currentRunId ?? "none"})`,
      );
      return;
    }
    void runtime.stop().then(
      () => emitResponse(command.id, "abort", true),
      (err: unknown) => emitResponse(command.id, "abort", false, redactError(err)),
    );
  }

  return {
    promise,
    stop() {
      if (runtime) void runtime.stop().catch(() => {});
    },
  };
}

/** Execute acceptance preflight: payload schema valid (already parsed),
 *  model valid/available in the runtime catalog, workspace valid. */
async function validateExecute(
  input: ExecuteCommand["input"],
  modelRuntime: ModelRuntime,
): Promise<string | null> {
  if (input.run.model.backendKind !== "coding_agent") {
    return `unsupported backend kind: ${input.run.model.backendKind}`;
  }
  if (!existsSync(input.workspace.root) || !statSync(input.workspace.root).isDirectory()) {
    return `workspace root is not a directory: ${input.workspace.root}`;
  }
  const catalog = await modelRuntime.getCatalog();
  const model = catalog.models.find(
    (m) => `${m.providerId}/${m.modelId}` === input.run.model.modelId,
  );
  if (!model) return `model not found in catalog: ${input.run.model.modelId}`;
  if (model.available === false) return `model unavailable: ${input.run.model.modelId}`;
  return null;
}
