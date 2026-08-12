import type { Model, ModelCompat, ThinkingLevel } from "./types.js";

// ── Catalog spec types (sparse input — omp ModelSpec pattern) ──

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
    anthropic: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 16_384,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          thinking: {
            mode: "adaptive",
            efforts: ["off", "low", "high", "max"],
            defaultLevel: "low",
          },
          compat: { forceAdaptiveThinking: true },
        },
        {
          id: "claude-haiku-3-5",
          name: "Claude Haiku 3.5",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8_192,
          cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        },
      ],
    },
    deepseek: {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [
        {
          id: "deepseek-chat",
          name: "DeepSeek Chat",
          reasoning: true,
          input: ["text"],
          contextWindow: 65_536,
          maxTokens: 8_192,
          cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
          thinking: { mode: "effort", efforts: ["off", "low", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
      ],
    },
    openai: {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [
        {
          id: "gpt-4o",
          name: "GPT-4o",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
        {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 128_000,
          maxTokens: 16_384,
          cost: { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
      ],
    },
  },
};

// ── Minimal YAML parser (for runtime models.yml loading by the caller) ──

function parseValue(s: string): unknown {
  const t = s.trim();
  if (t === "" || t === "null") return "";
  if (t === "true") return true;
  if (t === "false") return false;
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
  return root as unknown as CatalogSpec;
}
