import type { AgentHooks } from "./agent-hooks.js";
import type { Tool } from "./framework-adapter.js";

// ── Public types ──

export interface AgentScope {
  agentId: string;
  sessionId: string;
  cwd: string;
}

export interface AgentExtension {
  id?: string;
  hooks?: AgentHooks;
  tools?: readonly Tool[];
  systemPrompt?: string;
}

export interface AgentExtensionFactory {
  id?: string;
  create(scope: AgentScope): AgentExtension | Promise<AgentExtension>;
}

export interface ResolvedExtension {
  id?: string;
  extension: AgentExtension;
}

// ── Hook compositors ──

type BeforeRunHandler = NonNullable<AgentHooks["before:run"]>;
type BeforeModelHandler = NonNullable<AgentHooks["before:model"]>;
type BeforeToolHandler = NonNullable<AgentHooks["before:tool"]>;
type BeforeStopHandler = NonNullable<AgentHooks["before:stop"]>;

export function composeBeforeRun(handlers: readonly BeforeRunHandler[]): AgentHooks["before:run"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, input) => {
    let cur = input;
    for (const h of handlers) {
      const next = await h(ctx, cur);
      if (next) cur = next;
    }
    return cur;
  };
}

export function composeBeforeModel(
  handlers: readonly BeforeModelHandler[],
): AgentHooks["before:model"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, messages) => {
    let cur = [...messages];
    for (const h of handlers) cur = [...(await h(ctx, cur))];
    return cur;
  };
}

export function composeObserver<T extends unknown[]>(
  handlers: readonly ((...args: T) => void | Promise<void>)[],
): (...args: T) => Promise<void> {
  return async (...args) => {
    for (const h of handlers) await h(...args);
  };
}

export function composeBeforeTool(
  handlers: readonly BeforeToolHandler[],
): AgentHooks["before:tool"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, call) => {
    let cur = call;
    for (const h of handlers) {
      const d = await h(ctx, cur);
      if (!d) continue;
      if (d.skip || d.result !== undefined) return d;
      if (d.input !== undefined) cur = { ...cur, input: d.input };
    }
    return undefined;
  };
}

export function composeBeforeStop(
  handlers: readonly BeforeStopHandler[],
): AgentHooks["before:stop"] {
  if (handlers.length === 0) return undefined;
  return async (ctx, messages) => {
    const reasons: string[] = [];
    for (const h of handlers) {
      const d = await h(ctx, messages);
      if (d?.continue) reasons.push(d.reason);
    }
    return reasons.length > 0 ? { continue: true, reason: reasons.join("\n\n") } : undefined;
  };
}

// ── Tool merge ──

export function mergeTools(
  baseTools: readonly Tool[],
  contributions: readonly { owner: string; tools: readonly Tool[] }[],
): Tool[] {
  const result = [...baseTools];
  const owners = new Map<string, string>();
  for (const t of baseTools) owners.set(t.name, "base");
  for (const c of contributions) {
    for (const t of c.tools) {
      const prev = owners.get(t.name);
      if (prev) throw new Error(`Tool name collision: ${t.name}; ${prev} vs ${c.owner}`);
      owners.set(t.name, c.owner);
      result.push(t);
    }
  }
  return result;
}

// ── System prompt merge ──

export function mergeSystemPrompts(
  base: string | undefined,
  parts: readonly (string | undefined)[],
): string | undefined {
  const all = [base, ...parts].filter((x): x is string => Boolean(x));
  return all.length > 0 ? all.join("\n\n") : undefined;
}

// ── composeExtensions ──

export interface ComposeInput {
  resolved: readonly ResolvedExtension[];
  baseTools: readonly Tool[];
  baseSystemPrompt?: string;
}

export function composeExtensions(input: ComposeInput): AgentExtension {
  const exts = input.resolved.map((r) => r.extension);

  const c = collectContributions(exts);

  const hooks: AgentHooks = {
    "before:run": composeBeforeRun(c.beforeRun),
    "before:model": composeBeforeModel(c.beforeModel),
    "after:model": composeObserver(c.afterModel),
    "before:tool": composeBeforeTool(c.beforeTool),
    "after:tool": composeObserver(c.afterTool),
    "after:turn": composeObserver(c.afterTurn),
    "before:stop": composeBeforeStop(c.beforeStop),
  };

  const tools = mergeTools(
    input.baseTools,
    input.resolved.map((r) => ({ owner: r.id ?? "unknown", tools: r.extension.tools ?? [] })),
  );

  return {
    id: "composed",
    hooks: Object.values(hooks).some((v) => v != null) ? hooks : undefined,
    tools: tools.length > 0 ? tools : undefined,
    systemPrompt: mergeSystemPrompts(
      input.baseSystemPrompt,
      exts.map((e) => e.systemPrompt),
    ),
  };
}

// ── Internal collector ──

interface HookContributions {
  beforeRun: BeforeRunHandler[];
  beforeModel: BeforeModelHandler[];
  afterModel: ((...args: unknown[]) => void | Promise<void>)[];
  beforeTool: BeforeToolHandler[];
  afterTool: ((...args: unknown[]) => void | Promise<void>)[];
  afterTurn: ((...args: unknown[]) => void | Promise<void>)[];
  beforeStop: BeforeStopHandler[];
}

function collectContributions(exts: readonly AgentExtension[]): HookContributions {
  const r: HookContributions = {
    beforeRun: [],
    beforeModel: [],
    afterModel: [],
    beforeTool: [],
    afterTool: [],
    afterTurn: [],
    beforeStop: [],
  };
  for (const ext of exts) {
    const h = ext.hooks;
    if (!h) continue;
    if (h["before:run"]) r.beforeRun.push(h["before:run"]);
    if (h["before:model"]) r.beforeModel.push(h["before:model"]);
    if (h["after:model"]) r.afterModel.push(h["after:model"] as (...args: unknown[]) => void);
    if (h["before:tool"]) r.beforeTool.push(h["before:tool"]);
    if (h["after:tool"]) r.afterTool.push(h["after:tool"] as (...args: unknown[]) => void);
    if (h["after:turn"]) r.afterTurn.push(h["after:turn"] as (...args: unknown[]) => void);
    if (h["before:stop"]) r.beforeStop.push(h["before:stop"]);
  }
  return r;
}

// ── ExtensionHost ──

export class ExtensionHost {
  readonly #factories: readonly AgentExtensionFactory[];

  constructor(factories: readonly AgentExtensionFactory[]) {
    this.#factories = factories;
  }

  async resolve(scope: AgentScope): Promise<readonly ResolvedExtension[]> {
    const result: ResolvedExtension[] = [];
    for (const factory of this.#factories) {
      result.push({ id: factory.id, extension: await factory.create(scope) });
    }
    return result;
  }
}
