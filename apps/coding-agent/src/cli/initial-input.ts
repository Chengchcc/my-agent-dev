import { randomUUID } from "node:crypto";
import type { BackendRunInput } from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";

/** Build the BackendRunInput for a one-shot CLI run: current cwd as the
 *  workspace, empty Product history, the first available model as the model
 *  ref, no Product Tools, no system prompt. */
export async function buildCliRunInput(opts: {
  prompt: string;
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
}): Promise<BackendRunInput<"coding_agent">> {
  const catalog = await opts.modelRuntime.getCatalog();
  const model = catalog.models.find((m) => m.available !== false);
  if (!model) {
    throw new Error("no available model in the catalog (check provider credentials)");
  }
  const modelId = `${model.providerId}/${model.modelId}`;
  const runId = `cli-${randomUUID()}`;
  return {
    history: [],
    input: {
      inputId: `cli-in-${randomUUID()}`,
      message: { role: "user", text: opts.prompt },
    },
    run: {
      runId,
      model: { backendKind: "coding_agent", modelId },
      productTools: [],
      configRevision: 0,
    },
    workspace: { root: opts.workspaceRoot, access: "read_write" },
    metadata: { conversationId: "cli", agentMemberId: "cli", branchId: "cli" },
  };
}
