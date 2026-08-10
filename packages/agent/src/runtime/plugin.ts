import type { Message } from "@my-agent-team/message";
import type { CodingAgentLoopEvent } from "./agent-event.js";

export interface PluginTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /** "serial" (default) = must run alone; "concurrent" = read-only, safe to
   *  run in parallel with other concurrent tools in the same turn. */
  readonly executionMode?: "serial" | "concurrent";
  /** "native" (default) for runtime tools; "product" for Product Tools so
   *  consumers can map tool events to the right observation stream. */
  readonly kind?: "native" | "product";
  execute(
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    /** Per-call execution context: the model tool-use id (stable per-run
     *  idempotency identity for Product Tools). */
    options?: { callId?: string },
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface PluginHooks {
  beforeModel?(messages: readonly Message[]): readonly Message[];
  beforeStop?(cancel: () => void): void;
  /** After a tool executes: a plugin may return a UI-transient event (e.g.
   *  todo_update) that the loop emits. Events are best-effort and never
   *  touch the canonical conversation history. */
  afterTool?(toolName: string, result: unknown): CodingAgentLoopEvent | undefined;
}

export interface MetaSectionProvider {
  readonly name: string;
  render(): string;
}

export interface Plugin {
  readonly name: string;
  readonly hooks?: PluginHooks;
  readonly tools?: readonly PluginTool[];
  readonly meta?: readonly MetaSectionProvider[];
}

export function validatePlugins(plugins: readonly Plugin[]): void {
  const names = new Set<string>();
  const toolNames = new Set<string>();
  for (const p of plugins) {
    if (names.has(p.name)) throw new Error(`Duplicate plugin name: ${p.name}`);
    names.add(p.name);
    for (const t of p.tools ?? []) {
      if (toolNames.has(t.name))
        throw new Error(`Duplicate tool name: ${t.name} (plugin ${p.name})`);
      toolNames.add(t.name);
    }
  }
}

export function renderMeta(plugins: readonly Plugin[]): string {
  return plugins
    .flatMap((p) => p.meta ?? [])
    .map((m) => `## ${m.name}\n${m.render()}`)
    .join("\n\n");
}

export function collectTools(plugins: readonly Plugin[]): PluginTool[] {
  return plugins.flatMap((p) => p.tools ?? []);
}
