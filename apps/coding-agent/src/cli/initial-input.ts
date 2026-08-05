import { randomUUID } from "node:crypto";
import type { BackendRunInput } from "@my-agent-team/agent-backend";
import type { ModelRuntime } from "@my-agent-team/ai";
import { UsageError } from "./args.js";

/** One-shot CLI stdin bound: a hostile `cat huge-file | coding-agent -p`
 *  must not balloon memory. */
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

/** Read piped stdin for print/json one-shot runs. Returns undefined when
 *  stdin is a TTY or carries only whitespace. RPC mode NEVER calls this: its
 *  stdin is the JSONL command stream. */
export async function readPipedStdin(
  stream: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_STDIN_BYTES) {
        throw new UsageError("piped stdin exceeds 16 MiB");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  const trimmed = text.trim();
  return trimmed || undefined;
}

/** Merge the CLI prompt with piped stdin: stdin comes FIRST, then a blank
 *  line, then the instruction (the classic `git diff | cli -p "review"`
 *  shape). Whitespace-only parts are dropped. */
export function mergeInitialInput(input: { prompt?: string; piped?: string }): string {
  const parts = [input.piped?.trim(), input.prompt?.trim()].filter((part): part is string =>
    Boolean(part),
  );
  return parts.join("\n\n");
}

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
