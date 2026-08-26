import type { ModelRuntime } from "@chengchenccc/ai";
import type { Message } from "@chengchenccc/message";
import { buildCliRunInput } from "../cli/initial-input.js";
import { assemblePluginRuntime } from "../core/plugins/plugin-resolve.js";
import { createOmaRuntime } from "../core/runtime/create-runtime.js";
import { newSessionId } from "../core/session/session-file.js";
import { persistSessionTurn } from "../core/session/session-loop.js";

export interface CliRunOptions {
  prompt: string;
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  model?: string;
}
/** Final assistant text of an outcome Message: the plain `text` field, or the
 *  concatenated text blocks. Never falls back to placeholder text. */
export function assistantText(message: Message | undefined): string {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.length > 0) return message.text;
  if (Array.isArray(message.blocks)) {
    return message.blocks
      .filter((b) => b.type === "text" && typeof (b as { text?: string }).text === "string")
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** Print mode: one Run, one prompt; stdout gets ONLY the final assistant
 *  text; failures go to stderr with a non-zero exit code. The completed
 *  turn is persisted to a fresh session file (stdout stays clean). */
export async function runPrintMode(opts: CliRunOptions): Promise<number> {
  const built = await buildCliRunInput({
    prompt: opts.prompt,
    workspaceRoot: opts.workspaceRoot,
    modelRuntime: opts.modelRuntime,
    modelId: opts.model,
  });
  const sessionId = newSessionId();
  const pluginRt = await assemblePluginRuntime(built.workspace.root, "print");
  for (const w of pluginRt.warnings) console.error(`[plugin] ${w}`);
  const runtime = await createOmaRuntime({
    runId: built.run.runId,
    modelId: built.run.model.modelId,
    workspaceRoot: built.workspace.root,
    workspaceAccess: built.workspace.access,
    modelRuntime: opts.modelRuntime,
    skillRoots: built.run.skillRoots ?? [],
    enableNativeTodo: true,
    gateWorkspaceMcp: true,
    ...(pluginRt.plugins.length || pluginRt.mcpServers.length
      ? { pluginComponents: { plugins: pluginRt.plugins, mcpServers: pluginRt.mcpServers } }
      : {}),
    ...(built.run.permissionMode ? { permissionMode: built.run.permissionMode } : {}),
  });
  try {
    const segment = await runtime.run(built);
    const outcome = await segment.outcome;
    if (outcome.status === "completed") {
      await persistSessionTurn({
        sessionId,
        cwd: opts.workspaceRoot,
        runtime,
        // One-shot mode: no real-time hook, write the whole turn at once.
        messages: [built.input.message, ...(outcome.messages ?? [])],
      });
      // Final answer = the last assistant message with text in the
      // canonical sequence (ADR 0017).
      const finalAnswer = [...(outcome.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant" && (m.text?.trim() ?? "") !== "");
      const text = assistantText(finalAnswer);
      if (text) process.stdout.write(`${text}\n`);
      return 0;
    }
    process.stderr.write(`[oma] run failed: ${outcome.error ?? outcome.status}\n`);
    return 1;
  } finally {
    await runtime.close().catch(() => {});
    // The memory-learn pass is fire-and-forget: a one-shot process must not
    // exit before it settles, or the run's facts are lost (it has its own
    // 60s bound, so this await cannot hang).
    await runtime.memoryLearning()?.catch(() => {});
  }
}
