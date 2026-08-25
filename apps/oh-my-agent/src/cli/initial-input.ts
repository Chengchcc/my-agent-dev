import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { BackendRunInput } from "@chengchenccc/agent-backend";
import type { ModelRuntime } from "@chengchenccc/ai";
import { loadProjectSettings } from "../core/project-settings.js";
import { buildSystemPrompt, readMemorySummary } from "../core/prompts.js";
import { agentDir } from "../core/session-file.js";
import { readWorkspaceSystemPrompt } from "../core/workspace-context.js";
import { UsageError } from "./args.js";

/** Standalone skill roots (the Product passes its own via the run snapshot):
 *  `<workspace>/.oma/skills` first, then the user-global `<agentDir>/skills`.
 *  `skills` in `.oma/settings.json` overrides the defaults (absolute paths,
 *  or relative to the workspace root). The `enableClaude` / `enableCodex` /
 *  `enableAgents` toggles add Claude / Codex / agent skill dirs to the
 *  defaults. Only existing directories are returned. */
export function resolveStandaloneSkillRoots(workspaceRoot: string): string[] {
  const settings = loadProjectSettings(workspaceRoot);
  const configured = settings.skills;
  const candidates: string[] = [];
  if (configured && configured.length > 0) {
    for (const p of configured) {
      candidates.push(isAbsolute(p) ? p : join(workspaceRoot, p));
    }
  } else {
    candidates.push(join(workspaceRoot, ".oma", "skills"));
    candidates.push(join(agentDir(), "skills"));
    if (settings.enableClaude) {
      candidates.push(
        join(workspaceRoot, ".claude", "skills"),
        join(homedir(), ".claude", "skills"),
      );
    }
    if (settings.enableCodex) {
      candidates.push(join(workspaceRoot, ".codex", "skills"), join(homedir(), ".codex", "skills"));
    }
    if (settings.enableAgents) {
      candidates.push(
        join(workspaceRoot, ".agent", "skills"),
        join(workspaceRoot, ".agents", "skills"),
        join(homedir(), ".agent", "skills"),
        join(homedir(), ".agents", "skills"),
      );
    }
  }
  const roots: string[] = [];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) roots.push(dir);
  }
  return roots;
}

/** One-shot CLI stdin bound: a hostile `cat huge-file | oma -p`
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
 *  workspace, empty Product history, the requested model (canonical
 *  `<provider>/<model>` id) or the first available model, no Product Tools,
 *  no system prompt. */
export async function buildCliRunInput(opts: {
  prompt: string;
  workspaceRoot: string;
  modelRuntime: ModelRuntime;
  /** Canonical `<provider>/<model>` id; undefined = first available. */
  modelId?: string;
}): Promise<BackendRunInput<"oma">> {
  const catalog = await opts.modelRuntime.getCatalog();
  const model = opts.modelId
    ? catalog.models.find((m) => `${m.providerId}/${m.modelId}` === opts.modelId)
    : catalog.models.find((m) => m.available !== false);
  if (opts.modelId && !model) {
    throw new Error(`model not found in catalog: ${opts.modelId}`);
  }
  if (opts.modelId && model && model.available === false) {
    throw new Error(`model unavailable: ${opts.modelId}`);
  }
  if (!model) {
    throw new Error("no available model in the catalog (check provider credentials)");
  }
  const modelId = `${model.providerId}/${model.modelId}`;
  const runId = `cli-${randomUUID()}`;
  const skillRoots = resolveStandaloneSkillRoots(opts.workspaceRoot);
  const input: BackendRunInput<"oma"> = {
    input: {
      inputId: `cli-in-${randomUUID()}`,
      message: { role: "user", text: opts.prompt },
    },
    run: {
      runId,
      model: { backendKind: "oma", modelId },
      systemPrompt: buildSystemPrompt({
        workspacePrompt: readWorkspaceSystemPrompt(opts.workspaceRoot),
        memorySummary: readMemorySummary(opts.workspaceRoot),
        cwd: opts.workspaceRoot,
      }),
      configRevision: 0,
    },
    workspace: { root: opts.workspaceRoot, access: "read_write" },
    // Standalone agent: no product conversation/agent/branch identity.
  };
  if (skillRoots.length === 0) return input;
  return { ...input, run: { ...input.run, skillRoots } };
}
