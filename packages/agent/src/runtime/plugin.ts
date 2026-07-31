import type { Message } from "@my-agent-team/message";

export interface PluginTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  execute(
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface PluginHooks {
  beforeModel?(messages: readonly Message[]): readonly Message[];
  beforeStop?(cancel: () => void): void;
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
