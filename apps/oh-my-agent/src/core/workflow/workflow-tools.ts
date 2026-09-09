import type { PluginTool } from "../agent-runtime.js";
import { builtinAgentNames, isValidWorkflowName, resolveAgent } from "./subagent-registry.js";
import type {
  WorkflowAgentResult,
  WorkflowAgentSpec,
  WorkflowRunResult,
} from "./workflow-executor.js";

export {
  isValidWorkflowName,
  parseAgentDefinition,
  type SubagentRegistryEntry,
} from "./subagent-registry.js";

export interface WorkflowScriptResult {
  readonly ok: boolean;
  readonly totalTokens: number;
  readonly value: unknown;
}

export interface WorkflowToolDeps {
  readonly runWorkflow: (input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }) => Promise<WorkflowRunResult>;
  /** Executes an orchestration script in the vm sandbox (Phase 2). */
  readonly runScript: (input: { script: string; args?: unknown }) => Promise<WorkflowScriptResult>;
  /** Persist a script to `<workspace>/.oma/workflow/<name>.js` for reuse. */
  readonly writeScript: (name: string, content: string) => void;
  /** Load a saved script by name (B8: `workflow_run({name})` re-runs a
   *  saved workflow without re-supplying the body). null = not found. */
  readonly readScript: (name: string) => Promise<string | null>;
  /** 3.4: dispatch ONE named subagent (workflowId/agentId are minted by the
   *  wiring closure). `signal` is the calling loop's abort signal. */
  readonly runSubagent: (
    spec: WorkflowAgentSpec,
    signal?: AbortSignal,
  ) => Promise<WorkflowAgentResult>;
  /** 3.4: raw markdown of `<workspace>/.oma/agents/<name>.md`, or null when
   *  absent. The name is already validated before this is called. */
  readonly readAgentDefinition: (name: string) => Promise<string | null>;
  /** 3.4 Phase 3 control plane. */
  readonly listSubagents: () => Array<{
    handle: string;
    label: string;
    status: string;
    usage?: WorkflowAgentResult["usage"];
  }>;
  readonly getSubagentOutput: (handle: string) => {
    handle: string;
    status: string;
    result?: WorkflowAgentResult;
  };
  readonly stopSubagent: (handle: string) => { ok: boolean; error?: string };
}

/** Boundary narrowing: tool args arrive from the model as unknown-shaped
 *  JSON - validate each field before it enters the executor. */
function parseItem(raw: unknown): WorkflowAgentSpec {
  const item = raw as Record<string, unknown>;
  const schema = item.schema;
  const schemaRec: Readonly<Record<string, unknown>> | undefined =
    schema && typeof schema === "object" && !Array.isArray(schema)
      ? (schema as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    prompt: String(item.prompt ?? ""),
    ...(typeof item.label === "string" ? { label: item.label } : {}),
    ...(schemaRec ? { schema: schemaRec } : {}),
  };
}

export function createWorkflowTools(deps: WorkflowToolDeps): readonly PluginTool[] {
  const MAX_BATCH_TASKS = 8;
  const BATCH_CONCURRENCY = 4;
  const runWorkflow: PluginTool = {
    name: "run_workflow",
    description:
      "Fan out independent subagent tasks in parallel and aggregate their results. " +
      "Each item gets its own isolated agent session (same model, file tools). " +
      "Use for audits, migrations, and multi-source research. " +
      "Items: [{prompt, schema?, label?}]. Returns per-item text and schema-validated " +
      "output (1 retry on violation).",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        items: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            properties: {
              prompt: { type: "string" },
              label: { type: "string" },
              schema: { type: "object" },
            },
            required: ["prompt"],
          },
        },
      },
      required: ["items"],
    },
    async execute(args, signal) {
      const rawItems = Array.isArray(args.items) ? args.items : [];
      const workflowId = `wf-${crypto.randomUUID()}`;
      const result = await deps.runWorkflow({
        workflowId,
        label: typeof args.label === "string" ? args.label : "workflow",
        items: rawItems.map(parseItem),
        ...(signal ? { signal } : {}),
      });
      return { items: result.items, totalTokens: result.totalTokens, ok: result.ok };
    },
  };

  const runScript: PluginTool = {
    name: "workflow_run",
    description:
      "Run an orchestration script (top-level-await JS) that fans out subagents " +
      "via agent(prompt, {schema?, label?}) and pipeline(items, fn). Scripts have " +
      "NO fs/network access - agents do the work. Save reusable scripts with the " +
      "name argument (written to .oma/workflow/<name>.js), then re-run one later " +
      "with ONLY the name argument (loads the saved script).",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        // script XOR name: either a new body, or a saved workflow to re-run
        // (the runtime enforces the XOR — at least one must be present).
        script: { type: "string", maxLength: 32768 },
        name: { type: "string" },
        args: { type: "object" },
      },
    },
    async execute(args) {
      const rawScript = typeof args.script === "string" ? args.script : "";
      const name = typeof args.name === "string" && args.name.length > 0 ? args.name : null;
      if (name && !isValidWorkflowName(name)) {
        return { ok: false, error: `invalid workflow name (allowed: [a-z0-9-], max 64): ${name}` };
      }
      if (rawScript && name) deps.writeScript(name, rawScript);
      let script = rawScript;
      if (!script && name) {
        const saved = await deps.readScript(name);
        if (saved === null) {
          return { ok: false, error: `workflow "${name}" not found in .oma/workflow` };
        }
        script = saved;
      }
      if (!script) return { ok: false, error: "script or name is required" };
      const result = await deps.runScript({ script, args: args.args });
      return {
        ok: result.ok,
        totalTokens: result.totalTokens,
        value: result.value,
        scriptSaved: Boolean(rawScript && name),
      };
    },
  };

  const task: PluginTool = {
    name: "task",
    description:
      "Fan out subagents. BATCH (preferred): {context, tasks:[{name?, agent?, task, outputSchema?}]} — " +
      "context is shared background injected into every spawn; items run concurrently (max 4); " +
      "per-item text is capped at 5000 chars. Roles: task (full tools), explore (read-only), " +
      "plan (read-only planning), worker (full file tools), or any .oma/agents/<name>.md definition. " +
      "SINGLE (compat): {agent, prompt, schema?, background?, resume?} — background:true returns a " +
      "handle immediately (poll via task_output); {resume, prompt} continues the SAME subagent.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        context: {
          type: "string",
          description:
            "BATCH: shared background injected into every spawn's prompt (required with tasks)",
        },
        tasks: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          description: "BATCH: one subagent per item",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Stable label for the handle/result" },
              agent: { type: "string", description: "Role (default task)" },
              task: { type: "string", description: "Self-contained instructions" },
              outputSchema: { type: "object", description: "JSON schema for the final answer" },
            },
            required: ["task"],
          },
        },
        agent: { type: "string" },
        prompt: { type: "string" },
        schema: { type: "object" },
        resume: { type: "string" },
        background: { type: "boolean" },
      },
      // BATCH: context + tasks required; runtime enforces. SINGLE (compat):
      // agent XOR resume (with prompt required either way); runtime enforces.
    },
    async execute(args, signal) {
      const agent = typeof args.agent === "string" ? args.agent.trim() : "";
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const resume = typeof args.resume === "string" ? args.resume.trim() : "";

      // Batch fan-out (pi task.batch shape): required shared context +
      // per-item spawns under bounded concurrency. Flat single-spawn
      // params stay accepted (pi runtime is permissive across shapes).
      if (Array.isArray(args.tasks)) {
        const context = typeof args.context === "string" ? args.context.trim() : "";
        if (!context) {
          return {
            ok: false,
            error: "context is required for batch calls (shared background for every spawn)",
          };
        }
        const items = args.tasks as Array<Record<string, unknown>>;
        if (items.length === 0) return { ok: false, error: "tasks must be a non-empty array" };
        if (items.length > MAX_BATCH_TASKS) {
          return { ok: false, error: `too many tasks (${items.length}; max ${MAX_BATCH_TASKS})` };
        }
        const seen = new Set<string>();
        for (const item of items) {
          if (typeof item.task !== "string" || item.task.trim() === "") {
            return { ok: false, error: "each task item needs a non-empty task" };
          }
          if (typeof item.name === "string" && item.name.trim() !== "") {
            const key = item.name.trim().toLowerCase();
            if (seen.has(key)) {
              return { ok: false, error: `duplicate task name "${item.name.trim()}"` };
            }
            seen.add(key);
          }
        }
        // Resolve roles upfront: one unknown role fails the whole call
        // before any spawn (pi-aligned validation shape).
        const metas: Array<{
          label: string;
          agent: string;
          task: string;
          schema?: Readonly<Record<string, unknown>>;
          systemPrompt: string;
          tools?: readonly string[];
          modelId?: string;
        }> = [];
        for (const item of items) {
          const agent =
            typeof item.agent === "string" && item.agent.trim() !== "" ? item.agent.trim() : "task";
          const def = await resolveAgent(agent, deps.readAgentDefinition);
          if (!def) {
            return {
              ok: false,
              error: `unknown subagent "${agent}" (builtin: ${builtinAgentNames().join(", ")}; or .oma/agents/<name>.md)`,
            };
          }
          metas.push({
            label:
              typeof item.name === "string" && item.name.trim() !== ""
                ? item.name.trim()
                : `${agent}-${metas.length + 1}`,
            agent,
            task: item.task as string,
            schema:
              typeof item.outputSchema === "object" &&
              item.outputSchema !== null &&
              !Array.isArray(item.outputSchema)
                ? (item.outputSchema as Readonly<Record<string, unknown>>)
                : undefined,
            systemPrompt: def.systemPrompt,
            tools: def.tools,
            modelId: def.modelId,
          });
        }
        const results: Array<Record<string, unknown>> = [];
        let next = 0;
        const workers = Array.from(
          { length: Math.min(BATCH_CONCURRENCY, metas.length) },
          async () => {
            for (;;) {
              const index = next++;
              if (index >= metas.length) return;
              const meta = metas[index]!;
              const result = await deps.runSubagent(
                {
                  prompt: `${context}\n\n---\n\n${meta.task}`,
                  label: meta.label,
                  ...(meta.schema ? { schema: meta.schema } : {}),
                  systemPrompt: meta.systemPrompt,
                  ...(meta.tools ? { toolNames: meta.tools } : {}),
                  ...(meta.modelId ? { modelId: meta.modelId } : {}),
                },
                signal,
              );
              results[index] = {
                index: index + 1,
                name: meta.label,
                agent: meta.agent,
                ok: result.ok,
                text: (result.text ?? "").slice(0, 5000),
                ...(result.output !== undefined ? { output: result.output } : {}),
                ...(result.error ? { error: result.error } : {}),
                ...(result.usage ? { usage: result.usage } : {}),
                ...(result.handle ? { handle: result.handle } : {}),
                ...(result.resultPath ? { resultPath: result.resultPath } : {}),
              };
            }
          },
        );
        await Promise.all(workers);
        const lines = results.map(
          (r, i) =>
            `${i + 1}. ${r.name} (${r.agent}) — ${r.ok ? "ok" : "error"}\n${String(r.text ?? r.error ?? "")}`,
        );
        return {
          ok: results.every((r) => r.ok !== false),
          content: lines.join("\n\n"),
          results,
        };
      }
      if (!prompt) return { ok: false, error: "prompt is required" };
      if (resume) {
        const result = await deps.runSubagent(
          { prompt, ...(agent ? { label: agent } : {}), resumeHandle: resume },
          signal,
        );
        return { label: result.label, text: result.text, ok: result.ok };
      }
      if (!agent) return { ok: false, error: "agent (or resume handle) and prompt are required" };
      const def = await resolveAgent(agent, deps.readAgentDefinition);
      if (!def) {
        const builtin = builtinAgentNames().join(", ");
        return {
          ok: false,
          error: `unknown subagent "${agent}" (builtin: ${builtin}; or .oma/agents/<name>.md)`,
        };
      }
      const schema = args.schema;
      const result = await deps.runSubagent(
        {
          prompt,
          label: agent,
          ...(schema && typeof schema === "object" && !Array.isArray(schema)
            ? { schema: schema as Readonly<Record<string, unknown>> }
            : {}),
          systemPrompt: def.systemPrompt,
          ...(def.tools ? { toolNames: def.tools } : {}),
          ...(def.modelId ? { modelId: def.modelId } : {}),
          ...(args.background === true ? { background: true } : {}),
        },
        signal,
      );
      return {
        label: result.label,
        text: result.text,
        ok: result.ok,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.handle ? { handle: result.handle } : {}),
        ...(result.status ? { status: result.status } : {}),
      };
    },
  };

  const taskList: PluginTool = {
    name: "task_list",
    description: "List live task handles (label, status, usage).",
    executionMode: "serial",
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { tasks: deps.listSubagents() };
    },
  };

  const taskOutput: PluginTool = {
    name: "task_output",
    description:
      "Read a background task by handle: status (running/completed/failed/stopped) " +
      "and the result once finished.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
    },
    async execute(args) {
      const handle = typeof args.handle === "string" ? args.handle.trim() : "";
      if (!handle) return { ok: false, error: "handle is required" };
      const out = deps.getSubagentOutput(handle);
      return {
        handle: out.handle,
        status: out.status,
        ...(out.result ? { result: out.result } : {}),
      };
    },
  };

  const taskStop: PluginTool = {
    name: "task_stop",
    description: "Stop a live background task by handle.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
    },
    async execute(args) {
      const handle = typeof args.handle === "string" ? args.handle.trim() : "";
      if (!handle) return { ok: false, error: "handle is required" };
      return deps.stopSubagent(handle);
    },
  };

  return [runWorkflow, runScript, task, taskList, taskOutput, taskStop];
}
