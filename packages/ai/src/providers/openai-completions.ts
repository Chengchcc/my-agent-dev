import type { AIMessageChunk } from "@chengchenccc/core";
import type {
  ImageBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@chengchenccc/message";
import { registerApi } from "../api-registry.js";
import { type ResolvedOpenAICompat, resolveOpenAICompat } from "../compat.js";
import type { Model, ProviderStreamOptions } from "../types.js";

// ─── Message conversion ───

/** data URL for an internal image block (OpenAI vision `image_url`). */
function imageDataUrl(b: ImageBlock): string {
  return `data:${b.mediaType};base64,${b.base64}`;
}

/** Content parts array for vision-capable models. OpenAI accepts `image_url`
 *  parts inside user messages and tool messages. */
function contentParts(text: string, images: readonly ImageBlock[]): unknown[] {
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images.map((img) => ({ type: "image_url", image_url: { url: imageDataUrl(img) } })),
  ];
}

/** Convert internal Message[] → OpenAI Chat Completions wire messages.
 *  - tool_result block → `{ role: "tool", tool_call_id, content }`
 *  - tool_use blocks   → `tool_calls` array (id + name + JSON-stringified args)
 *  - otherwise         → `{ role, content }` (text blocks joined, fallback to m.text)
 *  With `supportsDeveloperRole`, a "system" role is remapped to "developer".
 *  Images (pasted or read_image tool results) become `image_url` content
 *  parts instead of plain strings. */
function convertMessages(
  messages: readonly Message[],
  compat: ResolvedOpenAICompat,
): Record<string, unknown>[] {
  const role = (r: string): string =>
    r === "system" && compat.supportsDeveloperRole ? "developer" : r;

  return messages.flatMap((m): Record<string, unknown>[] => {
    if (m.blocks && m.blocks.length > 0) {
      const toolResults = m.blocks.filter((b): b is ToolResultBlock => b.type === "tool_result");
      if (toolResults.length > 0) {
        return toolResults.map((result) => ({
          role: "tool",
          tool_call_id: result.tool_use_id,
          content:
            result.images && result.images.length > 0
              ? contentParts(result.content, result.images)
              : result.content,
        }));
      }
      const toolCalls = m.blocks
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const text = m.blocks
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const images = m.blocks.filter((b): b is ImageBlock => b.type === "image");
      if (toolCalls.length > 0) {
        return [
          {
            role: role(m.role),
            content: images.length > 0 ? contentParts(text, images) : text || null,
            tool_calls: toolCalls,
          },
        ];
      }
      if (images.length > 0) {
        return [{ role: role(m.role), content: contentParts(text || m.text || "", images) }];
      }
      return [{ role: role(m.role), content: (text || m.text) ?? "" }];
    }
    return [{ role: role(m.role), content: m.text ?? "" }];
  });
}

// ─── Finish reason ───

function mapFinishReason(
  fr: string,
): "tool_use" | "end_turn" | "max_tokens" | "refusal" | undefined {
  if (fr === "tool_calls") return "tool_use";
  if (fr === "stop") return "end_turn";
  if (fr === "length") return "max_tokens";
  // OpenAI returns content_filter when safety refusal blocks the response.
  if (fr === "content_filter") return "refusal";
  return undefined;
}

// ─── buildRequest ───

function buildRequest(
  model: Model,
  messages: readonly Message[],
  opts?: ProviderStreamOptions,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const compat = resolveOpenAICompat(model);

  const body: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(messages, compat),
    [compat.maxTokensField]: model.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };

  // Reasoning/thinking wire shape varies by provider dialect.
  switch (compat.thinkingFormat) {
    case "deepseek":
      if (opts?.effort) body.thinking = { type: "enabled" };
      break;
    case "qwen":
      body.enable_thinking = !!opts?.effort;
      break;
    case "zai":
      body.thinking = { type: opts?.effort ? "enabled" : "disabled" };
      break;
    case "openrouter":
      body.reasoning = { effort: opts?.effort };
      break;
    default:
      break;
  }
  // o1/o3-style reasoning_effort (also wires into zai alongside `thinking`).
  if (compat.supportsReasoningEffort && opts?.effort) {
    body.reasoning_effort = opts.effort;
  }

  if (opts?.tools) {
    body.tools = opts.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema ?? {},
      },
    }));
  }
  // F5 structured output: Chat Completions JSON Schema mode. DeepSeek does
  // not support json_schema yet (real API returns 400), so its dialect
  // degrades to json_object — shape conformance is backstopped by the A2
  // validator on the consuming side.
  if (opts?.responseFormat) {
    if (compat.thinkingFormat === "deepseek") {
      body.response_format = { type: "json_object" };
      // DeepSeek rejects json_object unless the prompt contains the word
      // "json" — inject a system hint (the A2 validator still owns shape).
      const messages = body.messages as Array<Record<string, unknown>>;
      const sys = messages.find((m) => m.role === "system" || m.role === "developer");
      const jsonHint = " Output valid JSON only, matching the requested schema.";
      if (sys && typeof sys.content === "string") sys.content += jsonHint;
      else if (sys && Array.isArray(sys.content))
        (sys.content as Array<Record<string, unknown>>).push({
          type: "text",
          text: jsonHint.trim(),
        });
      else messages.unshift({ role: "system", content: jsonHint.trim() });
    } else {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: opts.responseFormat.name,
          schema: opts.responseFormat.schema,
          strict: opts.responseFormat.strict ?? true,
        },
      };
    }
  }

  return {
    url: "/chat/completions",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer {apiKey}",
    },
    body,
  };
}

// ─── createChunkConverter ───

/** Streaming converter for OpenAI Chat Completions SSE. Tool calls arrive as
 *  fragments: first chunk carries id+name, later chunks carry only index +
 *  function.arguments deltas. Maintains index → (id, name) so every argument
 *  fragment emits as input_json_delta paired to the initial tool. */
function createChunkConverter(): (raw: Record<string, unknown>) => Generator<AIMessageChunk> {
  const toolCallsByIndex = new Map<number, { id: string; name: string }>();
  // Some compat gateways omit tool_calls[].index. With the old `?? 0` every
  // such call collided on index 0, so parallel calls clobbered each other.
  // Assign a per-stream counter keyed by id so each new call gets a distinct
  // slot; argument fragments with neither id nor index assume the most recent.
  const indexById = new Map<string, number>();
  let nextMissingIndex = 0;
  let lastMissingIndex = 0;

  return function* convertChunk(raw: Record<string, unknown>): Generator<AIMessageChunk> {
    // Mid-stream error frame: throw so the consumer isn't left waiting for a
    // done signal that never arrives (matches anthropic's `error` handling).
    if (raw.error) {
      const e = raw.error as Record<string, unknown>;
      throw new Error(`OpenAI stream error: ${(e.message as string) ?? JSON.stringify(e)}`);
    }
    const choices = raw.choices as Array<Record<string, unknown>> | undefined;
    if (choices?.[0]) {
      const delta = choices[0].delta as Record<string, unknown> | undefined;
      if (delta?.content) {
        yield { delta: { type: "text", text: delta.content as string } };
      }
      if (delta?.reasoning_content) {
        yield { delta: { type: "reasoning", text: delta.reasoning_content as string } };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
          const id = (tc.id as string | undefined) ?? "";
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
          const name = (fn.name as string | undefined) ?? "";
          // Resolve the index: explicit if present, else counter keyed by id,
          // else assume the most recent tool call (single-stream fallback).
          let index: number;
          const rawIndex = tc.index as number | undefined;
          if (rawIndex !== undefined) {
            index = rawIndex;
          } else if (id) {
            const known = indexById.get(id);
            if (known !== undefined) {
              index = known;
            } else {
              index = nextMissingIndex++;
              lastMissingIndex = index;
              indexById.set(id, index);
            }
          } else {
            index = lastMissingIndex;
          }
          const existing = toolCallsByIndex.get(index);
          // Register the tool call on the chunk that announces id/name.
          if (id && !existing) {
            toolCallsByIndex.set(index, { id, name });
            yield { delta: { type: "tool_use", id, name } };
          } else if (name && existing && !existing.name) {
            // Name arrived in a later chunk; keep the id stable.
            toolCallsByIndex.set(index, { ...existing, name });
          }
          // Argument fragments are always deltas paired to the stored id.
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            const slot = existing ?? toolCallsByIndex.get(index);
            if (slot) {
              yield {
                delta: { type: "input_json_delta", id: slot.id, partial_json: fn.arguments },
              };
            }
          }
        }
      }
      if (choices[0].finish_reason) {
        const stopReason = mapFinishReason(choices[0].finish_reason as string);
        if (stopReason) yield { stopReason };
        // Clean end: signal done so consumers don't wait on a [DONE]
        // sentinel some gateways omit (matches anthropic/responses providers).
        yield { done: true };
      }
    }
    const usage = raw.usage as Record<string, unknown> | undefined;
    if (usage) {
      // OpenAI folds cached prompt tokens into prompt_tokens; pull them out so
      // input reflects the uncached count and cacheRead tracks the cache hit.
      const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined;
      const cached = details?.cached_tokens ?? 0;
      const prompt = (usage.prompt_tokens as number) ?? 0;
      yield {
        usage: {
          input: Math.max(0, prompt - cached),
          output: (usage.completion_tokens as number) ?? 0,
          cacheRead: cached,
        },
      };
    }
  };
}

registerApi("openai-completions", { buildRequest, createChunkConverter });
