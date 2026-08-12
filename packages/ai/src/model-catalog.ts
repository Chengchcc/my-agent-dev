import type { Model, ModelCompat, ThinkingLevel } from "./types.js";

// ── Catalog spec types (sparse input) ──

export type ThinkingMode = "effort" | "budget" | "adaptive";

export interface ThinkingConfig {
  mode: ThinkingMode;
  efforts: readonly string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
}

export interface ModelSpec {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinking?: ThinkingConfig;
  compat?: ModelCompat;
}

export interface ProviderSpec {
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  models: ModelSpec[];
}

export interface CatalogSpec {
  providers: Record<string, ProviderSpec>;
}

const DEFAULTS = {
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

function thinkingConfigToMap(tc: ThinkingConfig): Partial<Record<ThinkingLevel, string | null>> {
  const all: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
  const supported = new Set(tc.efforts);
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const lvl of all) {
    if (supported.has(lvl)) {
      map[lvl] = tc.effortMap?.[lvl] ?? lvl;
    } else {
      map[lvl] = null;
    }
  }
  return map;
}

/** Build a full Model from a sparse spec (omp: buildModel). */
export function buildModel(
  providerId: string,
  api: string,
  baseUrl: string,
  spec: ModelSpec,
): Model {
  return {
    id: spec.id,
    name: spec.name,
    provider: providerId,
    api,
    baseUrl,
    reasoning: spec.reasoning ?? DEFAULTS.reasoning,
    input: (spec.input ?? DEFAULTS.input) as Model["input"],
    contextWindow: spec.contextWindow ?? DEFAULTS.contextWindow,
    maxTokens: spec.maxTokens ?? DEFAULTS.maxTokens,
    cost: spec.cost ?? DEFAULTS.cost,
    thinkingLevelMap: spec.thinking ? thinkingConfigToMap(spec.thinking) : undefined,
    compat: spec.compat,
  };
}

/** Build all models from a catalog spec. Returns { providerId → { spec, models } }. */
export function buildAllModels(
  catalog: CatalogSpec,
): Record<string, { spec: ProviderSpec; models: readonly Model[] }> {
  const result: Record<string, { spec: ProviderSpec; models: readonly Model[] }> = {};
  for (const [pid, pspec] of Object.entries(catalog.providers)) {
    result[pid] = {
      spec: pspec,
      models: pspec.models.map((m) => buildModel(pid, pspec.api, pspec.baseUrl, m)),
    };
  }
  return result;
}

// ── Built-in fallback catalog (used when no runtime models.yml exists) ──

export const BUILTIN_CATALOG: CatalogSpec = {
  providers: {
    // ── Anthropic (a厂) — auto-activates with ANTHROPIC_API_KEY ──
    anthropic: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          thinking: {
            mode: "adaptive",
            efforts: ["off", "low", "medium", "high", "xhigh"],
            defaultLevel: "low",
          },
          compat: { forceAdaptiveThinking: true },
        },
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          thinking: {
            mode: "adaptive",
            efforts: ["off", "low", "medium", "high", "xhigh"],
            defaultLevel: "low",
          },
          compat: { forceAdaptiveThinking: true },
        },
        {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8_192,
          cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        },
      ],
    },
    // ── OpenAI (o厂) — auto-activates with OPENAI_API_KEY ──
    openai: {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true },
        },
        {
          id: "gpt-5.2",
          name: "GPT-5.2",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 400_000,
          maxTokens: 128_000,
          cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true },
        },
        {
          id: "gpt-5-mini",
          name: "GPT-5 Mini",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 400_000,
          maxTokens: 128_000,
          cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
      ],
    },
    // ── OpenAI Responses (o-series reasoning models) ──
    openaiResponses: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [
        {
          id: "o4-mini",
          name: "OpenAI o4 Mini",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 100_000,
          cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { supportsReasoningEffort: true },
        },
      ],
    },
    // ── DeepSeek — auto-activates with DEEPSEEK_API_KEY ──
    deepseek: {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash",
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "high", "xhigh"],
            defaultLevel: "off",
          },
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 384_000,
          cost: { input: 1, output: 2.5, cacheRead: 0.02, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "high", "xhigh"],
            defaultLevel: "off",
          },
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
      ],
    },
    // ── Groq — fast inference, auto-activates with GROQ_API_KEY ──
    groq: {
      api: "openai-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      models: [
        {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B (Groq)",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 32_768,
          cost: { input: 0.59, output: 0.79, cacheRead: 0.059, cacheWrite: 0.59 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
      ],
    },
    // ── OpenRouter — gateway to many providers ──
    openrouter: {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5 (OpenRouter)",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          compat: { thinkingFormat: "openrouter", maxTokensField: "max_tokens" },
        },
      ],
    },
  },
};

// ponytail: old model id → canonical id. Delete after DB migration.
// Existing agent rows may reference model ids from before the catalog
// refresh; this table bridges them to current catalog entries.
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-4-20250514": "claude-sonnet-5",
  "claude-opus-4-20250514": "claude-opus-4-8",
  "claude-haiku-3-5": "claude-haiku-4-5",
  "gpt-4o": "gpt-5.2",
  "gpt-4o-mini": "gpt-5-mini",
  "deepseek-chat": "deepseek-v4-flash",
};

/** Resolve a model id through the alias table. Returns the canonical
 *  id if an alias exists, otherwise the original id. */
export function resolveModelAlias(modelId: string): string {
  return MODEL_ALIASES[modelId] ?? modelId;
}

// ── Minimal YAML parser (for runtime models.yml loading by the caller) ──

// ponytail: strip a trailing ` # comment` — first space-hash run outside quotes.
function stripComment(t: string): string {
  let quote: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && i > 0 && t[i - 1] === " ") {
      return t.slice(0, i).trimEnd();
    }
  }
  return t;
}

function parseValue(s: string): unknown {
  const t = stripComment(s.trim());
  if (t === "null") return null;
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  // Quoted scalar: strip the matching surrounding quotes and keep it a string.
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  if (t.startsWith("{") && t.endsWith("}")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    for (const pair of splitTop(inner, ",")) {
      const ci = pair.indexOf(":");
      if (ci > 0) obj[pair.slice(0, ci).trim()] = parseValue(pair.slice(ci + 1));
    }
    return obj;
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitTop(inner, ",").map((s) => parseValue(s.trim()));
  }
  const num = Number(t);
  if (!Number.isNaN(num) && t !== "") return num;
  return t;
}

function splitTop(s: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{" || s[i] === "[") depth++;
    if (s[i] === "}" || s[i] === "]") depth--;
    if (s[i] === delim && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** Parse a models.yml text into a CatalogSpec. The caller handles file I/O
 *  (reads from `~/.my-agent/models.yml` or project `.my-agent/models.yml`). */
export function parseCatalogYAML(text: string): CatalogSpec {
  const root: Record<string, unknown> = {};
  const lines = text.split("\n");

  type Frame = {
    indent: number;
    obj: Record<string, unknown>;
    listKey: string | null;
  };
  const stack: Frame[] = [{ indent: -1, obj: root, listKey: null }];

  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li]!;
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();

    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const frame = stack[stack.length - 1]!;

    if (trimmed.startsWith("- ")) {
      const itemText = trimmed.slice(2).trim();
      const itemObj: Record<string, unknown> = {};
      if (frame.listKey) {
        const arr = frame.obj[frame.listKey];
        if (Array.isArray(arr)) arr.push(itemObj);
        else frame.obj[frame.listKey] = [itemObj];
      }
      if (itemText.includes(": ")) {
        const ci = itemText.indexOf(": ");
        itemObj[itemText.slice(0, ci).trim()] = parseValue(itemText.slice(ci + 2));
      } else if (frame.listKey) {
        const arr = frame.obj[frame.listKey] as unknown[];
        arr[arr.length - 1] = parseValue(itemText);
      }
      stack.push({ indent, obj: itemObj, listKey: null });
      continue;
    }

    const ci = trimmed.indexOf(":");
    if (ci < 0) continue;
    const key = trimmed.slice(0, ci).trim();
    const val = trimmed.slice(ci + 1).trim();

    if (val === "") {
      const next = lines.slice(li + 1).find((l) => l.trim() && !l.trim().startsWith("#"));
      const isList = next?.trim().startsWith("- ") ?? false;
      if (isList) {
        frame.obj[key] = [];
        stack.push({ indent, obj: frame.obj, listKey: key });
      } else {
        const child: Record<string, unknown> = {};
        frame.obj[key] = child;
        stack.push({ indent, obj: child, listKey: null });
      }
    } else {
      frame.obj[key] = parseValue(val);
    }
  }
  if (!root.providers) throw new Error("models.yml: missing 'providers' key");
  return root as unknown as CatalogSpec;
}
