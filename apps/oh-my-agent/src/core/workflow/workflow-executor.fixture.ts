import { ProviderError } from "@chengchenccc/ai";
import { createEchoModelStream } from "../__fixtures__/echo-model.js";
import { createWorkflowExecutor } from "./workflow-executor.js";

process.env.OMA_TITLE_ENABLED = "0";

export { createWorkflowExecutor, ProviderError };

export function createWorkflowFixture() {
  const events: Array<{ type: string }> = [];
  const emit = (e: unknown): void => {
    events.push(e as { type: string });
  };

  function makeDeps() {
    return {
      makeSubagentStream: (sessionId: string) => createEchoModelStream(`echo:${sessionId}`),
      modelId: "fake/echo",
      summarize: async () => "[summary]",
      contextBudget: { estimate: () => 0, limit: 100_000, triggerRatio: 0.7 },
      tools: [],
      workspaceRoot: "/tmp/wf-test",
      workspaceAccess: "read_only" as const,
      maxConcurrent: 2,
      maxTotal: 4,
      emit,
    };
  }

  return { events, emit, makeDeps };
}
