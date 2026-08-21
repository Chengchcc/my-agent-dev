import { readFileSync } from "node:fs";
import { join } from "node:path";
import basePrompt from "../prompts/system/base.md" with { type: "text" };
import memoryPrompt from "../prompts/system/memory.md" with { type: "text" };
import safetyPrompt from "../prompts/system/safety.md" with { type: "text" };
/** oma's own prompt layer (mirrors omp's src/prompts layout): base
 *  identity + safety + memory discipline live here as md files; workspace
 *  files (AGENTS.md / SOUL.md / USER.md + knowledge index) remain the
 *  agent-specific layer and are appended when present. Explicit
 *  run-input systemPrompt (Loop scopes) still wins wholesale — callers
 *  bypass this builder. */
export function buildSystemPrompt(input: {
  workspacePrompt?: string;
  cwd: string;
  /** Pre-read memory summary (workspace memory/memory_summary.md). */
  memorySummary?: string;
}): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}`;

  const parts = [basePrompt.trim(), safetyPrompt.trim()];
  const memoryBlock = input.memorySummary?.trim()
    ? `${memoryPrompt.trim()}\n\n<memory_summary>\n${input.memorySummary.trim()}\n</memory_summary>`
    : memoryPrompt.trim();
  parts.push(memoryBlock);
  if (input.workspacePrompt?.trim()) {
    parts.push(`<workspace_context>\n${input.workspacePrompt.trim()}\n</workspace_context>`);
  }
  parts.push(`Current date: ${date}`, `Current working directory: ${input.cwd}`);
  return parts.join("\n\n");
}

/** Workspace memory summary for prompt injection (absent when the agent
 *  has never written memories). */
export function readMemorySummary(cwd: string): string | undefined {
  try {
    const text = readFileSync(join(cwd, ".oma", "memory", "memory_summary.md"), "utf-8");
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}
