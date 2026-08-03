import type { MetaSectionProvider, Plugin } from "./plugin.js";
import type { TodoState } from "./todo.js";

/** Inputs for rendering the per-loop <system-reminder> Meta user message. */
export interface LoopMetaInput {
  readonly plugins: readonly Plugin[];
  readonly workspace: { readonly root: string; readonly cwd?: string };
  /** Resolved model display identity for the workspace/model fact line.
   *  Kept minimal so Meta rendering does not depend on a full Model type. */
  readonly model?: { readonly provider: string; readonly id: string };
  readonly productContext?: string;
  readonly todo?: TodoState;
}

function section(heading: string, body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  return `# ${heading}\n\n${trimmed}`;
}

/** Render the unified <system-reminder> Meta user message from runtime facts.
 *  Empty sections are omitted. The structure follows coding-agent-prompt.md. */
export function renderLoopMeta(input: LoopMetaInput): string {
  const sections: string[] = [];

  // Plugin Meta sections (skill index, todo helper, etc.)
  const pluginSections = input.plugins
    .flatMap((p) => p.meta ?? [])
    .map((m: MetaSectionProvider) => section(m.name, m.render()))
    .filter((s): s is string => s !== null);
  sections.push(...pluginSections);

  // Product context supplied in the snapshot
  if (input.productContext) {
    const pc = section("Product Context", input.productContext);
    if (pc) sections.push(pc);
  }

  // Workspace / runtime facts
  const wsParts: string[] = [`Workspace root: ${input.workspace.root}`];
  if (input.workspace.cwd) wsParts.push(`Working directory: ${input.workspace.cwd}`);
  if (input.model) wsParts.push(`Model: ${input.model.provider}/${input.model.id}`);
  const ws = section("Workspace", wsParts.join("\n"));
  if (ws) sections.push(ws);

  // Todo reminder
  if (input.todo && input.todo.items.length > 0) {
    const lines = input.todo.items.map(
      (i) => `- [${i.status === "done" ? "x" : " "}] ${i.text} (${i.id})`,
    );
    const todo = section("Todo", lines.join("\n"));
    if (todo) sections.push(todo);
  }

  if (sections.length === 0) return "";
  return `<system-reminder>\n${sections.join("\n\n")}\n</system-reminder>`;
}
