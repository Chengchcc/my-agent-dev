import type { PluginTool } from "@my-agent-team/agent";
import type { WorkflowAgentSpec, WorkflowRunResult } from "./workflow-executor.js";

export interface WorkflowToolDeps {
  readonly runWorkflow: (input: {
    workflowId: string;
    label: string;
    items: readonly WorkflowAgentSpec[];
    signal?: AbortSignal;
  }) => Promise<WorkflowRunResult>;
  /** Phase 2 fills this; Phase 1 passes a throwing stub (run_workflow is the
   *  only tool until the evaluator lands). */
  readonly runScript: (input: { script: string; args?: unknown }) => Promise<WorkflowRunResult>;
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
  const runWorkflow: PluginTool = {
    name: "run_workflow",
    description:
      "Fan out independent subagent tasks in parallel and aggregate their results. " +
      "Each item gets its own isolated agent session (same model, file tools). " +
      "Use for audits, migrations, and multi-source research. " +
      "Items: [{prompt, schema?, label?}]. Returns per-item text and schema-parsed output.",
    executionMode: "serial",
    inputSchema: {
      type: "object",
      properties: {
        label: { type: "string" },
        concurrency: { type: "number", maximum: 8 },
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
      const workflowId = `wf-${Date.now().toString(36)}`;
      const result = await deps.runWorkflow({
        workflowId,
        label: typeof args.label === "string" ? args.label : "workflow",
        items: rawItems.map(parseItem),
        ...(signal ? { signal } : {}),
      });
      return { items: result.items, totalTokens: result.totalTokens, ok: result.ok };
    },
  };
  return [runWorkflow];
}
