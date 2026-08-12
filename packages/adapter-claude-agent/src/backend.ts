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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentBackend,
  BackendEvent,
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
} from "@my-agent-team/agent-backend";
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

/** Branch-pinned session id file: `{"sessionId": "..."}` (ADR 0002). */
const SESSION_REL = join(".my-agent", "claude-session");

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
    const sessionFile = join(workspace, SESSION_REL, `${input.metadata.branchId}.json`);
    const resumeId = readSessionId(sessionFile);

    const mcpConfigPath = this.writeMcpConfig(input, workspace);

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
    void this.consumeStdout(handle, input, sessionFile);
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
    if (modelId) args.push("--model", modelId);
    if (input.run.model.reasoningEffort && input.run.model.reasoningEffort !== "none") {
      const effort =
        input.run.model.reasoningEffort === "max" ? "high" : input.run.model.reasoningEffort;
      args.push("--effort", effort);
    }
    if (this.permissionMode) args.push("--permission-mode", this.permissionMode);
    if (resumeId) args.push("--resume", resumeId);
    if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
    if (input.run.systemPrompt) args.push("--append-system-prompt", input.run.systemPrompt);
    return args;
  }

  /** The driving input as ONE stream-json user message. When the branch
   *  has no claude session yet, the projected history is rendered as flat
   *  text inside the same message (ponytail: first-turn-only bridge). */
  private buildStdinInput(input: BackendRunInput<"claude_code">, resume: boolean): string {
    const inputText = input.input.message.text ?? "";
    let prompt = inputText;
    if (!resume && input.history.length > 0) {
      const historyText = input.history
        .map((h) => {
          const who = h.message.role === "user" ? "User" : "Assistant";
          return `${who}: ${h.message.text}`;
        })
        .join("\n\n");
      prompt = `${historyText}\n\n${inputText}`;
    }
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    });
  }

  /** Product Tools mounting (D3): write the standard mcp.json and pass it
   *  via --mcp-config. Returns null when the entrypoint is not a real SSE
   *  url (unconfigured deployment). */
  private writeMcpConfig(input: BackendRunInput<"claude_code">, workspace: string): string | null {
    const entrypoint = input.run.productTools[0]?.entrypoint ?? "";
    if (!entrypoint.startsWith("sse:")) return null;
    const url = entrypoint.slice(4);
    const headers =
      this.productToolsToken !== undefined
        ? { Authorization: `Bearer ${this.productToolsToken}` }
        : undefined;
    const dir = join(workspace, ".my-agent");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "claude-mcp.json");
    writeFileSync(
      path,
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          "product-tools": { type: "sse", url, ...(headers ? { headers } : {}) },
        },
      }),
    );
    return path;
  }

  /** Single stdout parse loop + stdin write. The terminal outcome is
   *  decided ONLY here (result event / error / exit code). */
  private async consumeStdout(
    handle: ActiveRun,
    input: BackendRunInput<"claude_code">,
    sessionFile: string,
  ): Promise<void> {
    const acc = createClaudeAccumulator();
    try {
      handle.proc.writeLine(this.buildStdinInput(input, existsSync(sessionFile)));
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
      });
    }
    // Persist the session id for --resume continuation (ADR 0002).
    if (acc.sessionId) {
      try {
        writeSessionId(sessionFile, acc.sessionId);
      } catch {
        /* session persistence failure is not a run failure */
      }
    }
    this.active.delete(handle.runId);
  }
}

function readSessionId(sessionFile: string): string | null {
  try {
    if (!existsSync(sessionFile)) return null;
    const parsed = JSON.parse(readFileSync(sessionFile, "utf8")) as { sessionId?: string };
    return parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

function writeSessionId(sessionFile: string, sessionId: string): void {
  mkdirSync(dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ sessionId }));
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
