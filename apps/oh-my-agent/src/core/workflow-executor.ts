import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContextBudget,
  type ContextSummarizer,
  createInMemorySessionStore,
  createOmaSession,
  type OmaLoopEvent,
  type OmaSession,
  type PluginTool,
} from "@chengchenccc/agent";
import type { ProjectedHistoryItem, Usage } from "@chengchenccc/agent-backend";
import type { AIMessageChunk } from "@chengchenccc/core";
import type { Message } from "@chengchenccc/message";
import subagentPrompt from "../prompts/agents/subagent.md" with { type: "text" };

export interface WorkflowAgentSpec {
  readonly prompt: string;
  readonly label?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
  /** 3.4: registry-provided role prompt (`.oma/agents/*.md` body or a
   *  builtin role); the generic subagent tail is appended by the executor. */
  readonly systemPrompt?: string;
  /** 3.4: tool name allowlist — a subset of the executor's file tools.
   *  `explore` uses read/grep/glob/tree/read_image; undefined = all. */
  readonly toolNames?: readonly string[];
  /** 3.4: per-call model override (provider/model id, resolved like the
   *  run's own model). Defaults to the run model. */
  readonly modelId?: string;
  /** 3.4 Phase 2: resume an existing subagent handle with a follow-up
   *  prompt (its spec snapshot is pinned at first dispatch). */
  readonly resumeHandle?: string;
  /** 3.4 Phase 3: fire-and-forget — returns immediately with the handle in
   *  `running` state; the result lands on the handle (subagent_output). */
  readonly background?: boolean;
}

export interface WorkflowAgentResult {
  readonly label: string;
  readonly text: string;
  readonly output?: unknown;
  readonly ok: boolean;
  readonly error?: string;
  readonly usage?: Usage;
  /** A3: full text spilled to this workspace-relative path (read it back
   *  with the read tool instead of carrying it inline). */
  readonly resultPath?: string;
  /** A4: workspace-relative paths the subagent wrote/edited (write/edit
   *  tool calls), so the parent has a visible handoff surface. */
  readonly artifacts?: readonly string[];
  /** 3.4 Phase 2: subagent handle — pass it back via `resumeHandle` to
   *  continue the same session with a follow-up prompt. */
  readonly handle?: string;
  /** 3.4 Phase 3: present on background dispatch acknowledgements
   *  (`running`) and stored on the handle after completion. */
  readonly status?: "running" | "completed" | "failed" | "stopped";
}

export interface WorkflowRunResult {
  readonly items: readonly WorkflowAgentResult[];
  readonly totalTokens: number;
  readonly ok: boolean;
}

/** Same shape as the session's modelStream option: the subagent session calls
 *  it with its own messages/signal/tools. The `modelId` override comes from
 *  the role definition (3.4) and must resolve in the runtime catalog. */
export type SubagentModelStream = (
  messages: readonly Message[],
  signal?: AbortSignal,
  tools?: readonly PluginTool[],
  modelId?: string,
) => AsyncIterable<AIMessageChunk>;

export interface WorkflowExecutorOptions {
  /** Build the subagent model stream (same model + reasoning as the run,
   *  unless the role pins a `modelId` override). */
  readonly makeSubagentStream: (sessionId: string, modelId?: string) => SubagentModelStream;
  readonly modelId: string;
  readonly summarize: ContextSummarizer;
  readonly contextBudget: ContextBudget;
  /** File tools only (no workflow/product tools - recursion + clobber guards). */
  readonly tools: readonly PluginTool[];
  readonly workspaceRoot: string;
  readonly workspaceAccess: "read_only" | "read_write";
  readonly maxConcurrent: number;
  readonly maxTotal: number;
  readonly emit: (event: OmaLoopEvent) => void;
  /** Optional product budget gate: consulted BEFORE each spawn. */
  readonly budgetGate?: () => { allowed: boolean; reason?: string };
  /** Optional wall-clock deadline per subagent (B7). Undefined = no
   *  deadline (the model call keeps its own per-call timeout). */
  readonly perAgentTimeoutMs?: number;
}

export interface WorkflowExecutor {
  runSubagent(
    input: { workflowId: string; agentId: string } & WorkflowAgentSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowAgentResult>;
  runWorkflow(input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }): Promise<WorkflowRunResult>;
  /** 3.4 Phase 3 control plane. */
  listSubagents(): Array<{
    handle: string;
    label: string;
    status: string;
    usage?: Usage;
  }>;
  getSubagentOutput(handle: string): {
    handle: string;
    status: string;
    result?: WorkflowAgentResult;
  };
  stopSubagent(handle: string): { ok: boolean; error?: string };
  /** Stop every live subagent (run teardown cascade). */
  abortAllSubagents(): void;
}

const SUBAGENT_SYSTEM_PROMPT = subagentPrompt.trim();

/** A2: minimal JSON-Schema subset validator for model-supplied output
 *  schemas — covers type / properties / required / enum / items (the exact
 *  Loop triage shape, loop-step.ts renderTriageWorkflow). Unknown keywords
 *  pass through; this is a guard, not a full validator.
 *  Upgrade path: replace with provider-native structured output
 *  (ChatModel.stream responseFormat) once that lands; the validator then
 *  stays as a backstop and the schema-correction retry is kept. */
function matchesSchemaType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown types never reject
  }
}

/** Returns a human-readable violation, or undefined when the value
 *  conforms to the supported subset. */
function validateJsonSchema(
  value: unknown,
  schema: Readonly<Record<string, unknown>>,
): string | undefined {
  const types = (
    Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  ) as string[];
  if (types.length > 0 && !types.some((t) => matchesSchemaType(t, value))) {
    return `expected ${types.join("|")}, got ${value === null ? "null" : typeof value}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `value not in enum (${JSON.stringify(schema.enum).slice(0, 120)})`;
  }
  if (matchesSchemaType("object", value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema.required as readonly string[] | undefined) ?? []) {
      if (!(key in record)) return `missing required property "${key}"`;
    }
    const props = schema.properties as Readonly<Record<string, unknown>> | undefined;
    if (props) {
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in record) {
          const err = validateJsonSchema(
            record[key],
            propSchema as Readonly<Record<string, unknown>>,
          );
          if (err) return `${key}: ${err}`;
        }
      }
    }
    return undefined;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validateJsonSchema(value[i], schema.items as Readonly<Record<string, unknown>>);
      if (err) return `[${i}]: ${err}`;
    }
  }
  return undefined;
}

/** A3 fan-in size guard: per-item inline ceiling, total inline budget, and
 *  the excerpt length kept in the tool result when a text is spilled. */
const MAX_INLINE_ITEM_CHARS = 2000;
const MAX_TOTAL_INLINE_CHARS = 16_000;
const EXCERPT_CHARS = 400;

/** Parse the loop's final text against the optional schema. Returns the
 *  parsed output (validated) plus a violation message when it fails. */
function parseAndValidate(
  result: Awaited<ReturnType<OmaSession["startLoop"]>>,
  schema: WorkflowAgentSpec["schema"],
): { text: string; output?: unknown; parseError?: string } {
  const text = (result.messages?.at(-1)?.text ?? "").trim();
  if (!schema || !text) return { text };
  try {
    const parsed = JSON.parse(text) as unknown;
    const schemaError = validateJsonSchema(parsed, schema);
    if (schemaError) return { text, parseError: `schema validation failed: ${schemaError}` };
    return { text, output: parsed };
  } catch {
    return { text, parseError: `schema output is not valid JSON: ${text.slice(0, 120)}` };
  }
}

export function createWorkflowExecutor(opts: WorkflowExecutorOptions): WorkflowExecutor {
  let totalSpawned = 0;
  let current = 0;
  const waiters: Array<() => void> = [];
  /** 3.4 Phase 2: live subagent handles — session + pinned spec snapshot.
   *  Per-run executor instance, so the table dies with the run. */
  const subagentHandles = new Map<
    string,
    {
      session: OmaSession;
      store: ReturnType<typeof createInMemorySessionStore>;
      sessionId: string;
      workflowId: string;
      agentId: string;
      spec: WorkflowAgentSpec;
      status: "running" | "completed" | "failed" | "stopped";
      result?: WorkflowAgentResult;
      stopRequested?: boolean;
    }
  >();

  async function acquire(signal?: AbortSignal): Promise<void> {
    if (current < opts.maxConcurrent) {
      current++;
      return;
    }
    if (signal?.aborted) throw new Error("workflow aborted while queued");
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = waiters.indexOf(fire);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("workflow aborted while queued"));
      };
      const fire = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiters.push(fire);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Cover the abort-between-check-and-listen race.
      if (signal?.aborted) onAbort();
    });
  }
  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else current--;
  }

  class WorkflowGateError extends Error {}

  function gate(): void {
    if (totalSpawned >= opts.maxTotal) {
      throw new WorkflowGateError(`workflow exceeds the ${opts.maxTotal}-agent cap`);
    }
    if (opts.budgetGate) {
      const decision = opts.budgetGate();
      if (!decision.allowed) {
        throw new WorkflowGateError(decision.reason ?? "workflow budget exhausted");
      }
    }
    totalSpawned++;
  }

  async function runSubagent(
    input: { workflowId: string; agentId: string } & WorkflowAgentSpec,
    signal?: AbortSignal,
  ): Promise<WorkflowAgentResult> {
    // Phase 2 resume: reuse a live handle's session + pinned spec snapshot
    // (later registry edits never mutate an existing handle's definition).
    const existing = input.resumeHandle ? subagentHandles.get(input.resumeHandle) : null;
    if (input.resumeHandle && !existing) {
      const active = [...subagentHandles.keys()].join(", ");
      return {
        label: input.label ?? input.resumeHandle,
        text: "",
        ok: false,
        error: `unknown subagent handle "${input.resumeHandle}" (active: ${active || "none"})`,
      };
    }
    const spec = existing?.spec ?? input;
    const workflowId = existing?.workflowId ?? input.workflowId;
    const agentId = existing?.agentId ?? input.agentId;
    const sessionId = existing?.sessionId ?? `wf:${workflowId}:${agentId}`;
    await acquire(signal);
    // gate() may throw (cap/budget): it runs inside the try so the acquired
    // concurrency slot is ALWAYS released - a leak here would deadlock every
    // later acquire once all slots are gone.
    try {
      gate();
      const label = input.label ?? agentId;
      const agentSignal =
        opts.perAgentTimeoutMs !== undefined
          ? signal
            ? AbortSignal.any([signal, AbortSignal.timeout(opts.perAgentTimeoutMs)])
            : AbortSignal.timeout(opts.perAgentTimeoutMs)
          : signal;
      opts.emit({
        type: "workflow_agent_started",
        workflowId,
        agentId,
        label,
      });
      // Role body + the generic subagent tail (constraints live once).
      const systemPrompt = spec.systemPrompt
        ? `${spec.systemPrompt}\n\n${SUBAGENT_SYSTEM_PROMPT}`
        : SUBAGENT_SYSTEM_PROMPT;
      const modelId = spec.modelId ?? opts.modelId;
      const subagentTools = spec.toolNames
        ? opts.tools.filter((t) => (spec.toolNames as readonly string[]).includes(t.name))
        : opts.tools;
      const store = existing?.store ?? createInMemorySessionStore();
      if (!existing) {
        // The loop opens the session record on startLoop: seed it first
        // (same contract as the run runtime's create-runtime.ts).
        await store.create({
          sessionId,
          backendKind: "oma",
          workspaceRoot: opts.workspaceRoot,
          leafEntryId: null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      const session =
        existing?.session ??
        createOmaSession({
          sessionId,
          store,
          plugins: [{ name: "subagent-tools", tools: subagentTools }],
          maxSteps: 8,
          maxForceContinues: 2,
          // Transient model failures (429/timeout) retry via the loop's
          // default retryStream policy (maxAttempts 3).
          modelStream: opts.makeSubagentStream(sessionId, modelId),
          summarize: opts.summarize,
          contextBudget: opts.contextBudget,
        });
      const handle = existing ? input.resumeHandle! : `sub-${crypto.randomUUID()}`;
      if (!existing) {
        subagentHandles.set(handle, {
          session,
          store,
          sessionId,
          workflowId,
          agentId,
          spec,
          status: "running",
        });
      }
      const onAbort = (): void => session.stop();
      agentSignal?.addEventListener("abort", onAbort, { once: true });
      const loopInput = {
        run: {
          runId: sessionId,
          model: { backendKind: "oma" as const, modelId },
          systemPrompt,
          configRevision: 0,
        },
        workspace: { root: opts.workspaceRoot, access: opts.workspaceAccess },
        metadata: { conversationId: "", agentMemberId: "", branchId: "" },
      };
      // startFollowUp is the resume primitive: same session, no Meta re-send.
      const launch = (
        history: readonly ProjectedHistoryItem[],
        inputMsg: { inputId: string; message: { role: "user"; text: string } },
      ): Promise<Awaited<ReturnType<OmaSession["startLoop"]>>> =>
        existing
          ? session.startFollowUp({ ...loopInput, history: [], input: inputMsg })
          : session.startLoop({ ...loopInput, history, input: inputMsg });
      const finish = async (): Promise<WorkflowAgentResult> => {
        // Never launch into an already-aborted signal: an abort that landed
        // before the model stream registered its listener would otherwise
        // leave the loop awaiting an abort event that will never fire.
        if (agentSignal?.aborted) {
          return {
            label,
            text: "",
            ok: false,
            error:
              agentSignal.reason instanceof Error
                ? agentSignal.reason.message
                : "workflow agent aborted",
          };
        }
        let result: Awaited<ReturnType<OmaSession["startLoop"]>>;
        try {
          result = await launch([], {
            inputId: agentId,
            // Same envelope as oh-my-pi's subagent-user-prompt template.
            message: { role: "user", text: `Complete assignment thoroughly:\n\n${spec.prompt}` },
          });
        } finally {
          agentSignal?.removeEventListener("abort", onAbort);
        }
        // A4: collect the subagent's write/edit artifacts BEFORE the store
        // closes (advisory — failures never fail the run).
        const artifactPaths = new Set<string>();
        try {
          const branch = await store.readBranch(sessionId);
          for (const entry of branch) {
            if (entry.type !== "message") continue;
            for (const block of entry.message.blocks ?? []) {
              if (block.type !== "tool_use" || (block.name !== "write" && block.name !== "edit")) {
                continue;
              }
              const p = (block.input as { path?: unknown } | undefined)?.path;
              if (typeof p === "string" && p.length > 0) artifactPaths.add(p);
            }
          }
        } catch {
          /* best-effort */
        }
        const artifacts = [...artifactPaths];
        // Resume keeps the store alive for the handle; only a fresh dispatch
        // closes it.
        if (!existing) {
          void store.close().catch((err) => {
            console.error(`[workflow] subagent store close failed for ${sessionId}:`, err);
          });
        }
        let { text, output, parseError } = parseAndValidate(result, spec.schema);
        if (parseError && !agentSignal?.aborted && result.status === "completed") {
          // A2: one schema-correction turn — the same session re-runs with the
          // produced messages as history plus an explicit fix instruction. A
          // second violation is terminal.
          const correction =
            `Your previous final message did not match the required output schema. ` +
            `Return ONLY the corrected JSON. Error: ${parseError}`;
          result = await launch(
            (result.messages ?? []).map((message, i) => ({
              // Synthetic identity: the in-memory subagent store never
              // persists canonical messages, so the id is only for the loop's
              // internal append bookkeeping.
              productEntryId: `sub:${agentId}:${i}`,
              message,
            })),
            {
              inputId: `${agentId}:schema-fix`,
              message: { role: "user", text: correction },
            },
          );
          ({ text, output, parseError } = parseAndValidate(result, spec.schema));
        }
        const loopError =
          result.status !== "completed"
            ? (result.error ?? `subagent loop ${result.status}`)
            : undefined;
        const error = agentSignal?.aborted
          ? agentSignal.reason instanceof Error
            ? agentSignal.reason.message
            : "workflow agent timed out"
          : (loopError ?? parseError);
        const agentResult: WorkflowAgentResult = {
          label,
          text,
          ok: result.status === "completed" && !error,
          ...(output !== undefined ? { output } : {}),
          ...(error ? { error } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
          // Phase 2: the handle is minted on first dispatch; resume calls the
          // same handle back (no new handle on follow-ups).
          ...(existing ? {} : { handle }),
        };
        // A1: best-effort per-subagent state dump — the audit trail survives
        // a crash/abort that the in-memory store cannot.
        const safeName = (s: string): boolean => /^[A-Za-z0-9-]+$/.test(s);
        if (opts.workspaceAccess === "read_write" && safeName(workflowId) && safeName(agentId)) {
          try {
            const rel = `.workflows/${workflowId}/${agentId}.state.json`;
            const abs = join(opts.workspaceRoot, rel);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(
              abs,
              JSON.stringify(
                {
                  workflowId,
                  agentId,
                  label,
                  ok: agentResult.ok,
                  ...(agentResult.error ? { error: agentResult.error } : {}),
                  status: result.status,
                  ...(result.usage ? { usage: result.usage } : {}),
                  ...(artifacts.length > 0 ? { artifacts } : {}),
                  messages: result.messages ?? [],
                  updatedAt: Date.now(),
                },
                null,
                2,
              ),
            );
          } catch (err) {
            console.error(`[workflow] state dump failed for ${input.agentId}:`, err);
          }
        }
        opts.emit({
          type: "workflow_agent_completed",
          workflowId,
          agentId,
          label,
          ok: agentResult.ok,
          ...(agentResult.error ? { error: agentResult.error } : {}),
          ...(agentResult.usage ? { usage: agentResult.usage } : {}),
        });
        return agentResult;
      };

      // 3.4 Phase 3: fire-and-forget. Acknowledge immediately with the
      // handle; the result lands on the handle for subagent_output.
      if (spec.background) {
        const entry = subagentHandles.get(handle);
        if (entry) entry.status = "running";
        void finish()
          .then((agentResult) => {
            const e = subagentHandles.get(handle);
            if (!e) return;
            if (e.stopRequested) {
              e.status = "stopped";
              e.result = { ...agentResult, ok: false, error: "stopped", status: "stopped" };
            } else {
              e.status = agentResult.ok ? "completed" : "failed";
              e.result = { ...agentResult, status: e.status };
            }
          })
          .catch((err) => {
            const e = subagentHandles.get(handle);
            if (e) {
              e.status = e.stopRequested ? "stopped" : "failed";
              e.result = {
                label,
                text: "",
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                status: e.status,
              };
            }
          });
        return { label, text: "", ok: true, handle, status: "running" };
      }
      return finish();
    } catch (err) {
      // Gate failures (cap/budget) are WORKFLOW-level: propagate so the
      // whole fan-out rejects instead of degrading to a failed agent row.
      if (err instanceof WorkflowGateError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      const label = input.label ?? agentId;
      opts.emit({
        type: "workflow_agent_completed",
        workflowId,
        agentId,
        label,
        ok: false,
        error: message,
      });
      return { label, text: "", ok: false, error: message };
    } finally {
      release();
    }
  }

  /** A3: keep fan-in results small enough to re-inject into the main loop.
   *  Long item texts spill to `.workflows/<wfId>/<agentId>.result.md` (the
   *  main session reads them back with the read tool); read_only workspaces
   *  degrade to inline truncation. The total-inline budget forces spill
   *  even when no single item exceeds the per-item ceiling. */
  function spillResults(
    results: readonly WorkflowAgentResult[],
    workflowId: string,
  ): WorkflowAgentResult[] {
    const total = results.reduce((acc, r) => acc + r.text.length, 0);
    const forceSpill = total > MAX_TOTAL_INLINE_CHARS;
    return results.map((r, i) => {
      if (!forceSpill && r.text.length <= MAX_INLINE_ITEM_CHARS) return r;
      const excerpt = r.text.slice(0, EXCERPT_CHARS);
      if (opts.workspaceAccess !== "read_write") {
        return { ...r, text: `${excerpt}…[truncated]` };
      }
      const rel = `.workflows/${workflowId}/a${i}.result.md`;
      const abs = join(opts.workspaceRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, r.text);
      return { ...r, text: excerpt, resultPath: rel };
    });
  }

  async function runWorkflow(input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }): Promise<WorkflowRunResult> {
    opts.emit({
      type: "workflow_started",
      workflowId: input.workflowId,
      label: input.label,
      agentCount: input.items.length,
    });
    // Own controller: a gate failure (cap/budget) or abort must stop
    // in-flight siblings (B1) instead of orphaning them while Promise.all
    // rejects and no terminal event is emitted.
    const controller = new AbortController();
    const combined = input.signal
      ? AbortSignal.any([input.signal, controller.signal])
      : controller.signal;
    try {
      const rawResults = await Promise.all(
        input.items.map((item, i) =>
          runSubagent({ workflowId: input.workflowId, agentId: `a${i}`, ...item }, combined),
        ),
      );
      if (input.signal?.aborted) throw new Error("workflow aborted");
      const results = spillResults(rawResults, input.workflowId);
      const totalTokens = results.reduce(
        (acc, r) =>
          acc +
          (r.usage?.inputTokens ?? 0) +
          (r.usage?.outputTokens ?? 0) +
          (r.usage?.cacheReadTokens ?? 0) +
          (r.usage?.cacheWriteTokens ?? 0),
        0,
      );
      const ok = results.every((r) => r.ok);
      opts.emit({
        type: "workflow_completed",
        workflowId: input.workflowId,
        ok,
        agentCount: input.items.length,
        totalTokens,
      });
      return { items: results, totalTokens, ok };
    } catch (err) {
      controller.abort();
      opts.emit({
        type: "workflow_failed",
        workflowId: input.workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // 3.4 Phase 3 control plane.
  function listSubagents() {
    return [...subagentHandles.entries()].map(([handle, e]) => ({
      handle,
      label: e.spec.label ?? e.agentId,
      status: e.status,
      ...(e.result?.usage ? { usage: e.result.usage } : {}),
    }));
  }

  function getSubagentOutput(handle: string) {
    const e = subagentHandles.get(handle);
    if (!e) return { handle, status: "unknown" };
    if (e.result) {
      // A3 size guard applies to fetched results too.
      const [spilled] = spillResults([e.result], e.workflowId);
      return { handle, status: e.status, result: spilled };
    }
    return { handle, status: e.status };
  }

  function stopSubagent(handle: string) {
    const e = subagentHandles.get(handle);
    if (!e) return { ok: false, error: `unknown subagent handle "${handle}"` };
    e.stopRequested = true;
    e.session.stop();
    return { ok: true };
  }

  function abortAllSubagents() {
    for (const e of subagentHandles.values()) {
      e.stopRequested = true;
      e.session.stop();
    }
  }

  return {
    runSubagent,
    runWorkflow,
    listSubagents,
    getSubagentOutput,
    stopSubagent,
    abortAllSubagents,
  };
}
