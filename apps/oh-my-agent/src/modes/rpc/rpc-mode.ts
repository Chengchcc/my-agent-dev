import { existsSync, statSync } from "node:fs";
import type { BackendRunOutcome, BackendRunSegment } from "@chengchenccc/agent-contract";
import { debugLog } from "@chengchenccc/agent-contract";
import type { ModelRuntime } from "@chengchenccc/ai";
import { type Message, MessageSchema } from "@chengchenccc/message";
import { assemblePluginRuntime } from "../../core/plugins/plugin-resolve.js";
import {
  type ApprovalDecision,
  type ApprovalHandler,
  approvalTimeoutMs,
  withApprovalDeadline,
} from "../../core/runtime/approval.js";
import { createOmaRuntime, type OmaRuntime } from "../../core/runtime/create-runtime.js";
import { buildSystemPrompt, readMemorySummary } from "../../core/runtime/prompts.js";
import {
  appendSessionCompaction,
  appendSessionMessages,
  loadSessionMessages,
  newSessionId,
} from "../../core/session/session-file.js";
import {
  readWorkspaceSystemPrompt,
  scanWorkspaceSkillRoots,
} from "../../core/settings/workspace-context.js";
import type {
  AbortCommand,
  ExecuteCommand,
  OmaCommand,
  OmaOutput,
  SteerCommand,
} from "../../protocol/index.js";
import {
  codingAgentCommandSchema,
  eventOutputSchema,
  outcomeOutputSchema,
  responseOutputSchema,
} from "../../protocol/index.js";
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
  const emit = (output: OmaOutput): void => {
    const line = JSON.stringify(output);
    writeChain = writeChain.then(() => {
      write(`${line}\n`);
    });
  };
  const emitResponse = (
    id: string,
    command: OmaCommand["type"],
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

  let runtime: OmaRuntime | null = null;
  let currentRunId: string | null = null;
  let executed = false;
  let finished = false;

  const reader = createJsonlReader(stdin);

  /** runId → (callId → resolver). Late/unknown resolutions fail soft. */
  const pendingApprovalsByRun = new Map<string, Map<string, (d: ApprovalDecision) => void>>();

  const promise = (async (): Promise<number> => {
    try {
      for await (const line of reader.lines) {
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
        let command: OmaCommand;
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
          case "resolve_approval": {
            const resolve = pendingApprovalsByRun.get(command.runId)?.get(command.callId);
            if (resolve) {
              resolve({ decision: command.decision });
              emitResponse(command.id, "resolve_approval", true);
            } else {
              emitResponse(
                command.id,
                "resolve_approval",
                false,
                `no pending approval ${command.callId}`,
              );
            }
            break;
          }
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

  /** Validate + assemble the Runtime, START the loop, and emit the execute
   *  response ONLY once the loop is live (agent_start). Awaited by the
   *  reader so the acceptance response is always the first output AND
   *  implies steer/abort are routable; the outcome runs CONCURRENTLY via
   *  driveOutcome, keeping steer/abort routable for the whole run. */
  async function acceptExecute(command: ExecuteCommand): Promise<void> {
    const input = command.input;
    debugLog("oma", `execute_received runId=${input.run.runId}`);
    const err = await validateExecute(input, opts.modelRuntime);
    if (err) {
      emitResponse(command.id, "execute", false, err);
      return;
    }
    const runId = input.run.runId;
    // Session (ADR 0003 decision 6): the child owns its session file; the
    // product forwards the branch's opaque reference. Resume loads the
    // transcript as the loop's seed history (validated at the file
    // boundary); a ref whose file is missing/empty degrades to a fresh
    // session (the first-turn bridge already lives in the input message).
    const resumeId = input.run.cliSessionRef;
    const sessionId = resumeId ?? newSessionId();
    const loaded = resumeId ? loadSessionMessages(resumeId) : [];
    // A corrupt line must degrade that entry (log + skip), never brick the
    // whole resume: MessageSchema.parse throws on the first bad shape.
    const parsedTranscript: { productEntryId: string; message: Message }[] = [];
    for (const [i, message] of loaded.entries()) {
      try {
        parsedTranscript.push({
          productEntryId: `session:${i}`,
          message: MessageSchema.parse(message) as Message,
        });
      } catch {
        console.warn(`[rpc] skipping malformed session line ${i} for ${resumeId}`);
      }
    }
    const sessionTranscript = parsedTranscript.length > 0 ? parsedTranscript : undefined;
    let effectiveInput: typeof input;

    let segment: BackendRunSegment<"oma">;
    try {
      // cwd-based meta (ADR 0003 decision 6): skills and the system prompt
      // live in workspace files (.oma/skills + AGENTS.md/SOUL.md/USER.md).
      // Explicit run-input values (Loop scopes) win over the cwd fallback.
      const cwdSkills = scanWorkspaceSkillRoots(input.workspace.root);
      const cwdPrompt = readWorkspaceSystemPrompt(input.workspace.root);
      effectiveInput = input.run.systemPrompt
        ? input
        : {
            ...input,
            run: {
              ...input.run,
              systemPrompt: buildSystemPrompt({
                workspacePrompt: cwdPrompt,
                memorySummary: readMemorySummary(input.workspace.root),
                cwd: input.workspace.root,
              }),
            },
          };
      // Plugin components (spec): policy resolved in the mode layer — RPC
      // NEVER loads project-scope code; user-scope needs enablement only.
      const pluginRt = await assemblePluginRuntime(input.workspace.root, "rpc");
      for (const w of pluginRt.warnings) debugLog("oma", `plugin: ${w}`);
      // HITL approval pipe (spec): emit approval_request on stdout, park the
      // resolver, resolve on the resolve_approval command; deadline = deny.
      const pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
      pendingApprovalsByRun.set(runId, pendingApprovals);
      let approvalSeq = 10_000;
      const rpcApproval: ApprovalHandler = (req) =>
        new Promise<ApprovalDecision>((resolve) => {
          pendingApprovals.set(req.callId, resolve);
          emit(
            eventOutputSchema.parse({
              type: "event",
              runId,
              // Own id space (10k+): the runtime's envelope seq is internal;
              // consumers key on type + data.callId, not global id order.
              event: {
                id: approvalSeq++,
                type: "approval_request",
                data: {
                  callId: req.callId,
                  toolName: req.toolName,
                  reason: req.reason ?? `${req.toolName} requested approval (${req.source})`,
                  input: req.input,
                },
              },
            }),
          );
        });
      runtime = await createOmaRuntime({
        runId,
        modelId: input.run.model.modelId,
        workspaceRoot: input.workspace.root,
        workspaceAccess: input.workspace.access,
        modelRuntime: opts.modelRuntime,
        skillRoots: input.run.skillRoots?.length ? input.run.skillRoots : cwdSkills,
        ...(pluginRt.plugins.length || pluginRt.mcpServers.length
          ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
          : {}),
        ...(input.run.permissionMode ? { permissionMode: input.run.permissionMode } : {}),
        approvalHandler: (req) => withApprovalDeadline(rpcApproval(req), approvalTimeoutMs()),
        sessionTranscript,
        onEvent: (event) => {
          if (!finished) emit(eventOutputSchema.parse({ type: "event", runId, event }));
        },
      });
      // run() resolves when the loop is live: acceptance ⟹ routable.
      segment = await runtime.run(effectiveInput as never);
      debugLog(
        "oma",
        `runtime_assembled runId=${runId} skills=${(input.run.skillRoots?.length ? input.run.skillRoots : cwdSkills).length} access=${input.workspace.access}`,
      );
    } catch (caught) {
      emitResponse(command.id, "execute", false, `runtime assembly failed: ${redactError(caught)}`);
      return;
    }

    // Acceptance: the runtime is assembled, event forwarding is registered,
    // the loop is live, and steer/abort route to it.
    currentRunId = runId;
    debugLog("oma", `loop_live runId=${runId}`);
    emitResponse(command.id, "execute", true, undefined);

    void driveOutcome(runtime, segment, runId, sessionId, effectiveInput.input.message);
  }
  /** Await the outcome, emit the outcome envelope, flush, close the runtime,
   *  then END the reader so the process exits on its own (one Run → one
   *  outcome → exit) - no dependency on the parent closing stdin. */
  async function driveOutcome(
    runtime: OmaRuntime,
    segment: BackendRunSegment<"oma">,
    runId: string,
    sessionId: string,
    inputMessage: Record<string, unknown>,
  ): Promise<void> {
    let outcome: BackendRunOutcome;
    try {
      outcome = await segment.outcome;
    } catch (caught) {
      outcome = { status: "failed", error: redactError(caught) };
    }
    // Persist the turn into the child's session file (user + assistant/tool
    // messages) so the next run resumes the transcript (ADR 0003).
    if (outcome.status === "completed" && outcome.messages?.length) {
      appendSessionMessages(sessionId, process.cwd(), [inputMessage, ...outcome.messages]);
      for (const summary of await runtime.compactions()) {
        appendSessionCompaction(sessionId, summary);
      }
    }
    const outcomeWithRef: BackendRunOutcome = {
      ...outcome,
      cliSessionRef: sessionId,
    };
    finished = true;
    await runtime.close().catch(() => {});
    debugLog("oma", `runtime_closed runId=${runId}`);
    emit(outcomeOutputSchema.parse({ type: "outcome", runId, outcome: outcomeWithRef }));
    debugLog("oma", `outcome runId=${runId} status=${outcome.status}`);
    await writeChain;
    // Unblock the reader: the pending stdin read resolves done and the main
    // promise returns; main() exits with the code. Never a hard process.exit
    // before the outcome is written and the runtime closed.
    await reader.cancel();
    debugLog("oma", `rpc_exit runId=${runId}`);
  }

  function handleSteer(command: SteerCommand): void {
    debugLog("oma", `steer_received runId=${command.runId}`);
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
    debugLog("oma", `abort_received runId=${command.runId}`);
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
  if (input.run.model.backendKind !== "oma") {
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
