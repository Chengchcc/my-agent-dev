import type { Plugin } from "./plugin.js";

/** Inputs for rendering the per-loop <system-reminder> Meta user message.
 *  Runtime facts only: plugin-loaded meta sections (skill index) and the
 *  workspace/model echo. Product-side content never rides this channel -
 *  backend-owned identity/config lives in the workspace files the system
 *  prompt reads (ADR 0003). */
export interface LoopMetaInput {
  readonly plugins: readonly Plugin[];
  readonly workspace: { readonly root: string; readonly cwd?: string };
  /** Resolved model display identity for the workspace/model fact line.
   *  Kept minimal so Meta rendering does not depend on a full Model type. */
  readonly model?: { readonly provider: string; readonly id: string };
}

function section(heading: string, body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  return `# ${heading}\n\n${trimmed}`;
}

/** Render the unified <system-reminder> Meta user message from runtime facts.
 *  Empty sections are omitted. The structure follows oma-prompt.md. */
export function renderLoopMeta(input: LoopMetaInput): string {
  const sections: string[] = [];

  // Plugin Meta sections (skill index, todo helper, etc.)
  const pluginSections = input.plugins
    .flatMap((p) => p.meta ?? [])
    .map((m) => section(m.name, m.render()))
    .filter((s): s is string => s !== null);
  sections.push(...pluginSections);

  // Workspace / runtime facts
  const wsParts: string[] = [`Workspace root: ${input.workspace.root}`];
  if (input.workspace.cwd) wsParts.push(`Working directory: ${input.workspace.cwd}`);
  if (input.model) wsParts.push(`Model: ${input.model.provider}/${input.model.id}`);
  const ws = section("Workspace", wsParts.join("\n"));
  if (ws) sections.push(ws);

  if (sections.length === 0) return "";
  return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}
