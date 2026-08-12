import type { AnthropicCompat, Model, OpenAICompat, ThinkingLevel } from "./types.js";

// ─── Anthropic compat resolver ───

const DEFAULT_ANTHROPIC = {
  supportsTemperature: true,
  supportsCacheControlOnTools: true,
  supportsLongCacheRetention: true,
  forceAdaptiveThinking: false,
  allowEmptySignature: false,
  supportsEagerToolInputStreaming: true,
} as const;

export interface ResolvedAnthropicCompat {
  supportsTemperature: boolean;
  supportsCacheControlOnTools: boolean;
  supportsLongCacheRetention: boolean;
  forceAdaptiveThinking: boolean;
  allowEmptySignature: boolean;
  supportsEagerToolInputStreaming: boolean;
}

export function resolveAnthropicCompat(model: Model): ResolvedAnthropicCompat {
  const c = model.compat as AnthropicCompat | undefined;
  if (!c || model.api !== "anthropic-messages") return DEFAULT_ANTHROPIC;
  return {
    supportsTemperature: c.supportsTemperature ?? DEFAULT_ANTHROPIC.supportsTemperature,
    supportsCacheControlOnTools:
      c.supportsCacheControlOnTools ?? DEFAULT_ANTHROPIC.supportsCacheControlOnTools,
    supportsLongCacheRetention:
      c.supportsLongCacheRetention ?? DEFAULT_ANTHROPIC.supportsLongCacheRetention,
    forceAdaptiveThinking: c.forceAdaptiveThinking ?? DEFAULT_ANTHROPIC.forceAdaptiveThinking,
    allowEmptySignature: c.allowEmptySignature ?? DEFAULT_ANTHROPIC.allowEmptySignature,
    supportsEagerToolInputStreaming:
      c.supportsEagerToolInputStreaming ?? DEFAULT_ANTHROPIC.supportsEagerToolInputStreaming,
  };
}

// ─── OpenAI compat resolver ───

const DEFAULT_OPENAI = {
  thinkingFormat: "none" as const,
  maxTokensField: "max_tokens" as const,
  supportsReasoningEffort: false,
  supportsDeveloperRole: false,
};

export interface ResolvedOpenAICompat {
  thinkingFormat: "none" | "deepseek" | "qwen" | "zai" | "openrouter";
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsReasoningEffort: boolean;
  supportsDeveloperRole: boolean;
}

export function resolveOpenAICompat(model: Model): ResolvedOpenAICompat {
  const c = model.compat as OpenAICompat | undefined;
  if (!c) return DEFAULT_OPENAI;
  return {
    thinkingFormat: c.thinkingFormat ?? DEFAULT_OPENAI.thinkingFormat,
    maxTokensField: c.maxTokensField ?? DEFAULT_OPENAI.maxTokensField,
    supportsReasoningEffort: c.supportsReasoningEffort ?? DEFAULT_OPENAI.supportsReasoningEffort,
    supportsDeveloperRole: c.supportsDeveloperRole ?? DEFAULT_OPENAI.supportsDeveloperRole,
  };
}

// ─── Thinking level clamp ───

/** Check if a thinking level is supported by a model. */
export function clampThinkingLevel(model: Model, level: ThinkingLevel): ThinkingLevel {
  const map = model.thinkingLevelMap;
  if (!map) return level;
  if (map[level] === null) {
    // Unsupported — fall back to "off" or the first supported.
    if (map.off !== null && map.off !== undefined) return "off";
    for (const key of Object.keys(map) as ThinkingLevel[]) {
      if (map[key] !== null && map[key] !== undefined) return key;
    }
  }
  return level;
}
