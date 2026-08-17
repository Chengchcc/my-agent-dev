import type { BackendRunOutcome } from "@chengchenccc/agent-backend";
import { buildCliRunInput } from "../cli/initial-input.js";
import { createOmaRuntime } from "../core/create-runtime.js";
import type { CliRunOptions } from "./print-mode.js";

/** JSON mode: one Run; stdout gets ALL events as JSONL plus exactly one
 *  terminal outcome line; then the process exits. stderr for logs only. */
export async function runJsonMode(opts: CliRunOptions): Promise<number> {
  const built = await buildCliRunInput({
    prompt: opts.prompt,
    workspaceRoot: opts.workspaceRoot,
    modelRuntime: opts.modelRuntime,
  });
  const runtime = await createOmaRuntime({
    runId: built.run.runId,
    modelId: built.run.model.modelId,
    workspaceRoot: built.workspace.root,
    workspaceAccess: built.workspace.access,
    modelRuntime: opts.modelRuntime,
    skillRoots: built.run.skillRoots ?? [],
    onEvent: (envelope) => {
      // Raw runtime event object, e.g. {"type":"agent_start"}.
      process.stdout.write(`${JSON.stringify({ type: "event", event: envelope.data })}\n`);
    },
  });
  try {
    const segment = await runtime.run(built);
    const outcome = await segment.outcome;
    process.stdout.write(
      `${JSON.stringify({ type: "outcome", outcome } satisfies { type: "outcome"; outcome: BackendRunOutcome })}\n`,
    );
    return outcome.status === "completed" ? 0 : 1;
  } finally {
    await runtime.close().catch(() => {});
  }
}
