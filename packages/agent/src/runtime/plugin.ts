import type { Message } from "@chengchenccc/message";
import type { OmaLoopEvent } from "./agent-event.js";
import type { PluginRuntime } from "./plugin-runtime.js";

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
  // ── Run lifecycle ──
  /** Called ONCE at Run start (after agent_start, before the first model
   *  turn). Plugins use it for per-Run setup (load state, reset counters). */
  beforeRun?(messages: readonly Message[], rt: PluginRuntime): void;
  /** Called ONCE after the entire agent loop ends (all turns done), before
   *  agent_end. Plugins use this for per-Run summaries (recap). */
  afterRun?(
    status: "completed" | "failed" | "stopped",
    messages: readonly Message[],
    rt: PluginRuntime,
  ): void | Promise<void>;

  // ── Model turn lifecycle ──
  /** Called before each model request; may transform messages. */
  beforeModel?(messages: readonly Message[], rt: PluginRuntime): readonly Message[];
  /** Called after each model turn (assistant text persisted, tools executed),
   *  before turn_end. */
  afterModel?(messages: readonly Message[], rt: PluginRuntime): void;

  // ── Tool execution lifecycle ──
  /** Called before a tool executes. May return `{ block: true, reason }` to
   *  prevent execution — an error tool result is emitted instead.
   *  Returning void/undefined = observe only. */
  beforeTool?(
    toolName: string,
    input: unknown,
    rt: PluginRuntime,
  ): undefined | { block?: boolean; reason?: string };
  /** Called after a tool executes. May return a UI-transient event OR a
   *  patch object `{ content?, isError?, terminate? }` that overrides the
   *  executed result field-by-field. */
  afterTool?(
    toolName: string,
    result: unknown,
    rt: PluginRuntime,
  ): OmaLoopEvent | { content?: unknown; isError?: boolean; terminate?: boolean } | undefined;
  /** Rewrite tool call arguments before execution.
   *  Use for deobfuscation, normalization, or injecting context. */
  transformToolArgs?(toolName: string, input: unknown, rt: PluginRuntime): unknown;
  // ── Stop decision lifecycle ──
  /** Called when the model naturally stops (no more tool calls). A plugin
   *  can veto by calling cancel() to force one more turn. */
  beforeStop?(cancel: () => void, rt: PluginRuntime): void;
  /** Called after the stop decision is finalized. `vetoed=true` means a
   *  plugin forced the loop to continue; `vetoed=false` means the loop
   *  accepted the natural stop (afterRun follows). */
  afterStop?(vetoed: boolean, rt: PluginRuntime): void;
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
