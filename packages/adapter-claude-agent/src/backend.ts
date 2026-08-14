/** ClaudeBackend: one execute() = one spawned claude child in stream-json
 *  mode (`-p --input-format stream-json`), the user message written to
 *  stdin, then the child exits. Context continuation (ADR 0002): the
 *  session_id captured from the first run is stored in a branch-pinned
 *  file and passed as `--resume <sessionId>` on later runs. No mid-turn
 *  steer — steer() rejects explicitly.
 *
 *  Wire format: claude 2.1.228 stream-json (docs/architecture/execution/
 *  backend-kinds-gate0.md). Permission mode: `--permission-mode
 *  bypassPermissions` is refused when running as root — the flag is only
 *  passed when explicitly configured. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@my-agent-team/agent-backend";
import { guardedConsume } from "@my-agent-team/agent-backend";
import {
  buildOutcomeMessages,
  createClaudeAccumulator,
  finalText,
  mapClaudeEvent,
} from "./event-mapper.js";
import { type SpawnedClaudeProcess, spawnClaudeProcess } from "./process.js";
import { parseClaudeLine } from "./wire.js";

export type ClaudeBackendErrorCode = "spawn_failed" | "conflict" | "not_found";

export class ClaudeBackendError extends Error {
  constructor(
    readonly code: ClaudeBackendErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaudeBackendOptions {
  /** claude executable (default "claude"; tests point at a fake-CLI). */
  executable?: string;
  /** Extra argv prepended to the built args (test injection). */
  args?: readonly string[];
  /** Extra env applied over the parent process env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Permission mode flag value; omitted by default because
   *  bypassPermissions is refused under root. */
  permissionMode?: string;
  /** Product Tools MCP bearer token for --mcp-config. */
  productToolsToken?: string;
  abortGraceMs?: number;
}

interface ActiveRun {
  readonly runId: string;
  readonly proc: SpawnedClaudeProcess;
  readonly settle: (outcome: BackendRunOutcome) => void;
  readonly outcome: Promise<BackendRunOutcome>;
  stopRequested: boolean;
  pushEvent(event: BackendEvent<"claude_code">): void;
  readonly events: AsyncIterable<BackendEvent<"claude_code">>;
}

export class ClaudeBackend implements AgentBackend<"claude_code"> {
  readonly kind = "claude_code" as const;
  private readonly executable: string;
  private readonly extraArgs: readonly string[];
  private readonly extraEnv: Readonly<Record<string, string | undefined>> | undefined;
  private readonly permissionMode: string | undefined;
  private readonly productToolsToken: string | undefined;
  private readonly abortGraceMs: number;
  private readonly active = new Map<string, ActiveRun>();
  private disposed = false;

  constructor(opts: ClaudeBackendOptions = {}) {
    this.executable = opts.executable ?? "claude";
    this.extraArgs = opts.args ?? [];
    this.extraEnv = opts.env;
    this.permissionMode = opts.permissionMode;
    this.productToolsToken = opts.productToolsToken;
    this.abortGraceMs = opts.abortGraceMs ?? 3_000;
  }

  async execute(input: BackendRunInput<"claude_code">): Promise<BackendRunSegment<"claude_code">> {
    const runId = input.run.runId;
    if (this.disposed) throw new ClaudeBackendError("conflict", "backend is shutting down");
    if (this.active.has(runId)) {
      throw new ClaudeBackendError("conflict", `runId ${runId} already has a live child process`);
    }

    const workspace = input.workspace.root;
    // The CLI owns its session (claude's own storage keyed by session_id);
    // the product forwards the branch's opaque reference only (ADR 0003).
    const resumeId = input.run.cliSessionRef ?? null;

    // The workspace bridge owns the single cwd .mcp.json (user servers +
    // product-tools, ADR 0003); pass it to claude only when it exists.
    const mcpPath = join(workspace, ".mcp.json");
    const mcpConfigPath = existsSync(mcpPath) ? mcpPath : null;

    const args = this.buildArgs(input, resumeId, mcpConfigPath);
    let proc: SpawnedClaudeProcess;
    try {
      proc = spawnClaudeProcess(
        { executable: this.executable, args: [...this.extraArgs, ...args], env: this.extraEnv },
        { cwd: workspace },
      );
    } catch (err) {
      throw new ClaudeBackendError(
        "spawn_failed",
        `claude spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const handle = createActiveRun(runId, proc);
    this.active.set(runId, handle);
    void this.consumeStdout(handle, input);
    return {
      events: handle.events,
      outcome: handle.outcome,
      stop: () => this.stop(runId),
    };
  }

  /** Per-turn short process: a steer cannot reach a live run. Explicit
   *  rejection — the Product layer cancels the steer input. */
  async steer(_runId: string, _input: BackendInputMessage): Promise<void> {
    throw new ClaudeBackendError(
      "not_found",
      "claude backend runs one short-lived process per turn; steer is unsupported — queue the input as a follow-up turn",
    );
  }

  async stop(runId: string): Promise<void> {
    const handle = this.active.get(runId);
    if (!handle) return;
    handle.stopRequested = true;
    handle.proc.kill("SIGTERM");
    const exited = await withTimeout(handle.proc.exit, this.abortGraceMs);
    if (exited === null) {
      handle.proc.kill("SIGKILL");
      await handle.proc.exit.catch(() => null);
    }
    handle.settle({
      status: "aborted",
      error: "stopped by product backend",
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const handles = [...this.active.values()];
    for (const h of handles) {
      h.stopRequested = true;
      h.proc.kill("SIGTERM");
    }
    await Promise.allSettled(
      handles.map(async (h) => {
        const exited = await withTimeout(h.proc.exit, this.abortGraceMs);
        if (exited === null) {
          h.proc.kill("SIGKILL");
          await h.proc.exit.catch(() => null);
        }
        h.settle({ status: "aborted", error: "backend disposed" });
      }),
    );
    this.active.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private buildArgs(
    input: BackendRunInput<"claude_code">,
    resumeId: string | null,
    mcpConfigPath: string | null,
  ): string[] {
    const args = [
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "-p",
    ];
    const modelId = input.run.model.modelId;
    if (modelId) {
      // The catalog uses canonical `<provider>/<model>` ids; the claude CLI
      // (and its API proxy) expects the BARE model name.
      const slash = modelId.indexOf("/");
      args.push("--model", slash > 0 ? modelId.slice(slash + 1) : modelId);
    }
    if (input.run.model.reasoningEffort && input.run.model.reasoningEffort !== "none") {
      const effort =
        input.run.model.reasoningEffort === "max" ? "high" : input.run.model.reasoningEffort;
      args.push("--effort", effort);
    }
    // Per-run frozen permission_mode (ADR 0020 decision 7): ask -> default
    // (prompts), auto -> acceptEdits, deny -> plan. bypassPermissions is
    // refused by the claude CLI under root/sudo - the workspace settings
    // (.claude/settings.json) pre-allow the product tools instead.
    const runPerm = input.run.permissionMode;
    if (runPerm) {
      const mode = runPerm === "auto" ? "acceptEdits" : runPerm === "deny" ? "plan" : "default";
      args.push("--permission-mode", mode);
    } else if (this.permissionMode) {
      args.push("--permission-mode", this.permissionMode);
    }
    if (resumeId) args.push("--resume", resumeId);
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    if (input.run.systemPrompt) args.push("--append-system-prompt", input.run.systemPrompt);
    return args;
  }

  /** The driving input as ONE stream-json user message. The first-turn
   *  history bridge (ADR 0003 decision 6) is already flat text inside the
   *  message, rendered by the Backend when the branch has no claude session
   *  reference yet. */
  private buildStdinInput(input: BackendRunInput<"claude_code">): string {
    const inputText = input.input.message.text ?? "";
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: inputText }],
      },
    });
  }

  /** Single stdout parse loop + stdin write. The terminal outcome is
   *  decided ONLY here (result event / error / exit code). */
  private async consumeStdout(
    handle: ActiveRun,
    input: BackendRunInput<"claude_code">,
  ): Promise<void> {
    await guardedConsume(() => this.consumeBody(handle, input), (message) => {
      handle.settle({ status: "failed", error: `stdout consume failed: ${message}` });
      this.active.delete(handle.runId);
    });
  }

  private async consumeBody(
    handle: ActiveRun,
    input: BackendRunInput<"claude_code">,
  ): Promise<void> {
    const acc = createClaudeAccumulator();
    try {
      handle.proc.writeLine(this.buildStdinInput(input));
      handle.proc.closeStdin();
    } catch {
      /* stdin closed early — the parse loop still reads stdout */
    }
    for await (const line of handle.proc.stdout) {
      if (line.trim() === "") continue;
      const evt = parseClaudeLine(line);
      if (!evt) continue;
      mapClaudeEvent(acc, evt);
      for (const e of acc.events.splice(0)) handle.pushEvent(e);
    }

    const exitCode = await handle.proc.exit.catch(() => null);

    if (handle.stopRequested) {
      // stop() already settled aborted.
    } else if (acc.error) {
      handle.settle({ status: "failed", error: acc.error, usage: acc.usage });
    } else if (acc.result?.isError) {
      handle.settle({
        status: "failed",
        error: acc.result.result ?? "claude result error",
        usage: acc.usage,
      });
    } else if (exitCode !== 0 && !acc.result) {
      const tail = handle.proc.stderrTail ? ` (stderr: ${handle.proc.stderrTail})` : "";
      handle.settle({
        status: "failed",
        error: `claude exited with code ${exitCode}${tail}`,
        usage: acc.usage,
      });
    } else {
      handle.settle({
        status: "completed",
        messages: buildOutcomeMessages(finalText(acc)),
        usage: acc.usage,
        // The claude session_id is the CLI-side runtime truth (ADR 0002);
        // the Product Backend records it on the branch.
        ...(acc.sessionId ? { cliSessionRef: acc.sessionId } : {}),
      });
    }
    this.active.delete(handle.runId);
  }
}

function createActiveRun(runId: string, proc: SpawnedClaudeProcess): ActiveRun {
  let settled = false;
  let settleOutcome: ((o: BackendRunOutcome) => void) | null = null;
  const queue: BackendEvent<"claude_code">[] = [];
  const waiters: Array<() => void> = [];
  let eventsClosed = false;

  const outcome = new Promise<BackendRunOutcome>((resolve) => {
    settleOutcome = resolve;
  });

  const handle: ActiveRun = {
    runId,
    proc,
    stopRequested: false,
    settle(o) {
      if (settled) return;
      settled = true;
      eventsClosed = true;
      settleOutcome?.(o);
      for (const w of waiters.splice(0)) w();
    },
    outcome,
    pushEvent(event) {
      if (eventsClosed) return;
      queue.push(event);
      for (const w of waiters.splice(0)) w();
    },
    events: (async function* () {
      while (!eventsClosed || queue.length > 0) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (eventsClosed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    })(),
  };
  return handle;
}

/** Race a promise against a timeout; the timer is cleared so a settled race
 *  never holds the event loop. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
