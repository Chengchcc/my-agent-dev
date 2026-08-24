import type { AIMessageChunk } from "@chengchenccc/core";
import type { ContentBlock, Message, TextBlock } from "@chengchenccc/message";
import { registerApi } from "../api-registry.js";
import { resolveAnthropicCompat } from "../compat.js";
import type { Model, ProviderStreamOptions } from "../types.js";

// ── Request assembly ──────────────────────────────────────────────

/** Provider/gateway output-token cap (zai/llmbox rejects >131072). */
const MAX_OUTPUT_TOKENS = 131_072;

function buildRequest(
  model: Model,
  messages: readonly Message[],
  opts?: ProviderStreamOptions,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const compat = resolveAnthropicCompat(model);
  const systemMsg = messages.find((m) => m.role === "system");
  const cacheControl = { type: "ephemeral" } as const;
  const request: Record<string, unknown> = {
    model: model.id,
    max_tokens: Math.min(model.maxTokens, MAX_OUTPUT_TOKENS),
    messages: convertMessages(messages, opts, { allowEmptySignature: compat.allowEmptySignature }),
    stream: true,
  };
  // System prompt: read text from both m.text and text blocks — some
  // callers populate only blocks. When cacheControl is enabled and a
  // system prompt exists, send it as a content-block array with an
  // ephemeral cache breakpoint on the last block. This turns multi-turn
  // re-processing of the stable system prompt into cache reads
  //
  const systemText = systemMsg
    ? [
        systemMsg.text,
        ...(systemMsg.blocks ?? [])
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text),
      ]
        .filter((t): t is string => typeof t === "string" && t.length > 0)
        .join("\n")
    : undefined;
  if (systemText) {
    if (opts?.cacheControl) {
      request.system = [{ type: "text", text: systemText, cache_control: cacheControl }];
    } else {
      request.system = systemText;
    }
  }
  // Tools: when cacheControl is enabled AND the API supports cache_control on
  // tool definitions, put an ephemeral breakpoint on the last tool — the tool
  // catalog is stable across turns.
  const tools = opts?.tools?.map((t, i, arr) => {
    const tool: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? {},
    };
    if (opts?.cacheControl && compat.supportsCacheControlOnTools && i === arr.length - 1) {
      tool.cache_control = cacheControl;
    }
    return tool;
  });
  if (tools) request.tools = tools;
  // F5 structured output: Anthropic has no native JSON mode, so a
  // report_result tool is injected carrying the caller's schema. tool_choice
  // is deliberately NOT forced — subagents must still call their file tools
  // first; the A2 validator backstops the final shape.
  if (opts?.responseFormat) {
    const toolList = tools ? [...tools] : [];
    toolList.push({
      name: "report_result",
      description: "Report the final result conforming to the required output schema",
      input_schema: opts.responseFormat.schema as Record<string, unknown>,
    });
    request.tools = toolList;
  }
  // Thinking control: forceAdaptiveThinking (Sonnet 4.6+) overrides
  // caller's type to "adaptive" — the model requires it.
  if (opts?.thinking) {
    const type = compat.forceAdaptiveThinking ? "adaptive" : opts.thinking.type;
    const thinking: Record<string, unknown> = { type };
    if (opts.thinking.display ?? compat.forceAdaptiveThinking)
      thinking.display = opts.thinking.display ?? "summarized";
    if (!compat.forceAdaptiveThinking && opts.thinking.budgetTokens)
      thinking.budget_tokens = opts.thinking.budgetTokens;
    request.thinking = thinking;
  }
  // Effort scales the whole response (thinking included); per the Messages
  // API it travels in output_config.
  if (opts?.effort) {
    request.output_config = { effort: opts.effort };
  }
  return {
    url: "/messages",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "{apiKey}",
      "anthropic-version": "2023-06-01",
    },
    body: request,
  };
}

// ── Message conversion (canonical → wire) ────────────────────────

type WireBlock = Record<string, unknown>;

/** Replace lone surrogates so partially-decoded text never breaks
 *  strict validators. */
function sanitizeSurrogates(text: string): string {
  // Replace only UNPAIRED surrogates:
  // high surrogate not followed by low, or low surrogate not preceded by
  // high. Valid surrogate pairs (emoji, CJK ext B) are preserved.
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );
}

function toWireBlock(
  b: ContentBlock,
  compat?: { allowEmptySignature?: boolean },
): WireBlock | null {
  if (b.type === "text") {
    const text = sanitizeSurrogates(b.text);
    return text.trim().length > 0 ? { type: "text", text } : null;
  }
  if (b.type === "thinking") {
    if (b.redacted) {
      return { type: "redacted_thinking", data: b.signature ?? "" };
    }
    const text = sanitizeSurrogates(b.text);
    // No signature: degrade to text block unless the
    // model accepts empty signatures (DeepSeek).
    if (!b.signature && !compat?.allowEmptySignature) {
      return text.trim().length > 0 ? { type: "text", text } : null;
    }
    if (text.trim().length === 0 && !b.signature) return null;
    return { type: "thinking", thinking: text, signature: b.signature ?? "" };
  }
  if (b.type === "tool_use") {
    return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  }
  if (b.type === "image") {
    return {
      type: "image",
      source: { type: "base64", media_type: b.mediaType, data: b.base64 },
    };
  }
  if (b.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: b.tool_use_id,
      ...(b.images && b.images.length > 0
        ? {
            content: [
              ...(b.content.trim() ? [{ type: "text", text: b.content }] : []),
              ...b.images.map((img) => ({
                type: "image",
                source: { type: "base64", media_type: img.mediaType, data: img.base64 },
              })),
            ],
          }
        : { content: b.content }),
      ...(b.is_error ? { is_error: true } : {}),
    };
  }
  return null;
}

/** Canonical messages → Anthropic wire messages. Consecutive `role:"tool"`
 *  messages merge into one `user(tool_result*)` message (strict validators
 *  want all results directly after the assistant tool_use batch). Messages
 *  that would carry empty content are skipped — the API rejects them. */
function convertMessages(
  messages: readonly Message[],
  opts?: ProviderStreamOptions,
  compat?: { allowEmptySignature?: boolean },
): Array<{ role: string; content: unknown }> {
  const wire: Array<{ role: string; content: unknown }> = [];
  const wireCompat = { allowEmptySignature: compat?.allowEmptySignature };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;

    if (m.role === "tool") {
      const results: WireBlock[] = [];
      let j = i;
      for (; j < messages.length; j++) {
        const tm = messages[j]!;
        if (tm.role !== "tool") break;
        for (const b of tm.blocks ?? []) {
          const wb = toWireBlock(b, wireCompat);
          if (wb?.type === "tool_result") results.push(wb);
        }
      }
      i = j - 1;
      if (results.length > 0) wire.push({ role: "user", content: results });
      continue;
    }

    if (m.blocks && m.blocks.length > 0) {
      const blocks = m.blocks
        .map((b) => toWireBlock(b, wireCompat))
        .filter((b): b is WireBlock => b !== null);
      if (blocks.length > 0) {
        // Compound shape: answer lives in `text`, `blocks` holds thinking
        // blocks only. Append the answer as a trailing text block unless a
        // text block already carried it (legacy shape).
        const text = (m.text ?? "").trim();
        if (text && !blocks.some((b) => b.type === "text")) {
          blocks.push({ type: "text", text: sanitizeSurrogates(m.text ?? "") });
        }
        wire.push({ role: m.role, content: blocks });
      } else if ((m.text ?? "").trim().length > 0) {
        wire.push({ role: m.role, content: sanitizeSurrogates(m.text ?? "") });
      }
    } else if ((m.text ?? "").trim().length > 0) {
      wire.push({ role: m.role, content: sanitizeSurrogates(m.text ?? "") });
    }
    // else: empty message — skip (API rejects empty content).
  }
  // Merge consecutive user wire messages into one: stream-rule reminders
  // and steer inputs can follow a user prompt or a tool_result batch, and
  // strict role alternation rejects back-to-back user turns. Text blocks
  // concatenate (tool_result blocks + trailing text is a valid user turn).
  for (let i = 1; i < wire.length; ) {
    const prev = wire[i - 1]!;
    const cur = wire[i]!;
    if (prev.role === "user" && cur.role === "user") {
      prev.content = [...toUserBlocks(prev.content), ...toUserBlocks(cur.content)];
      wire.splice(i, 1);
    } else {
      i++;
    }
  }

  // Cache conversation history: when cacheControl is enabled, put an
  // ephemeral breakpoint on the LAST user message's last content block.
  // This is the highest-value cache win — multi-turn re-processing of
  // the rolling conversation prefix turns into cache reads.
  if (opts?.cacheControl && wire.length > 0) {
    const last = wire[wire.length - 1]!;
    if (last.role === "user") {
      const cc = { type: "ephemeral" } as const;
      if (Array.isArray(last.content)) {
        const lastBlock = last.content[last.content.length - 1] as Record<string, unknown>;
        if (lastBlock) lastBlock.cache_control = cc;
      } else if (typeof last.content === "string") {
        last.content = [{ type: "text", text: last.content, cache_control: cc }];
      }
    }
  }
  return wire;
}

// ── SSE decoding ──────────────────────────────────────────────────

/** Full stop-reason mapping: the loop reacts to
 *  truncation (max_tokens) and refusal differently from a clean end. */
function mapStopReason(reason: string | undefined): AIMessageChunk["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      // Newer Claude models use this instead of max_tokens when the context
      // window is exceeded. The streamed content is valid but truncated
      // treat it the same as max_tokens so the loop can force-continue.
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "pause_turn":
      return "pause_turn";
    case "refusal":
    case "sensitive":
      // Safety filters / refusal: the turn is terminal but not a clean end.
      return "refusal";
    default:
      return "end_turn";
  }
}

function* convertChunks(
  raw: Record<string, unknown>,
  blockIdByIndex: Map<number, string>,
): Generator<AIMessageChunk> {
  const type = raw.type as string;

  if (type === "content_block_start") {
    const block = raw.content_block as Record<string, unknown>;
    const index = raw.index as number;
    if (block?.type === "tool_use") {
      const id = (block.id as string) ?? "";
      blockIdByIndex.set(index, id);
      yield { delta: { type: "tool_use", id, name: (block.name as string) ?? "" } };
    }
    if (block?.type === "redacted_thinking") {
      // The encrypted payload arrives in `data`; replay it unchanged.
      yield {
        delta: {
          type: "reasoning_signature",
          signature: (block.data as string) ?? "",
          redacted: true,
        },
      };
    }
    return;
  }

  if (type === "content_block_delta") {
    const d = raw.delta as Record<string, unknown>;
    if (d?.type === "text_delta") {
      yield { delta: { type: "text", text: sanitizeSurrogates((d.text as string) ?? "") } };
      return;
    }
    if (d?.type === "thinking_delta") {
      yield {
        delta: { type: "reasoning", text: sanitizeSurrogates((d.thinking as string) ?? "") },
      };
      return;
    }
    if (d?.type === "signature_delta") {
      yield { delta: { type: "reasoning_signature", signature: (d.signature as string) ?? "" } };
      return;
    }
    if (d?.type === "input_json_delta") {
      const index = raw.index as number;
      const id = blockIdByIndex.get(index) ?? "";
      yield {
        delta: { type: "input_json_delta", id, partial_json: (d.partial_json as string) ?? "" },
      };
      return;
    }
  }
  // Mid-stream error events (Anthropic sends `event: error` on
  // server-side failures). Must throw — silently swallowing leaves the
  // consumer waiting for a done signal that never arrives.
  if (type === "error") {
    const err = raw.error as Record<string, unknown>;
    throw new Error(`Anthropic stream error: ${(err?.message as string) ?? JSON.stringify(err)}`);
  }

  // message_start: capture input usage. Anthropic nests
  // usage inside raw.message.usage — a top-level read misses it entirely.
  // Cache tokens (cache_read_input_tokens, cache_creation_input_tokens)
  // are emitted here so cost accounting reflects cache hits.
  if (type === "message_start") {
    const u = (raw.message as { usage?: Record<string, number> })?.usage;
    if (u) {
      yield {
        usage: {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheCreate: u.cache_creation_input_tokens,
          cacheRead: u.cache_read_input_tokens,
        },
      };
    }
    return;
  }

  if (type === "message_delta") {
    const d = raw.delta as Record<string, unknown>;
    const reason = (d as { stop_reason?: string }).stop_reason;
    if (reason) {
      yield { stopReason: mapStopReason(reason) };
    }
    // message_delta also carries cumulative output usage.
    // Don't early-return on stop_reason — both can arrive in the same event.
    const du = raw.usage as Record<string, number> | undefined;
    if (du) {
      // message_delta only carries cumulative output_tokens; emitting input
      // (or cache fields) here would clobber the correct values captured in
      // message_start for last-wins consumers. Emit output alone.
      yield { usage: { output: du.output_tokens ?? 0 } };
    }
    return;
  }

  if (type === "message_stop") {
    yield { done: true };
    return;
  }
}

/** Per-stream chunk converter: owns a blockIdByIndex Map so tool-use index→id
 *  correlation persists across chunks in the same stream. create-provider.ts
 *  calls this once per stream and feeds it each raw SSE frame. */
function createChunkConverter(): (raw: Record<string, unknown>) => Generator<AIMessageChunk> {
  const blockIdByIndex = new Map<number, string>();
  return (raw: Record<string, unknown>) => convertChunks(raw, blockIdByIndex);
}

registerApi("anthropic-messages", { buildRequest, createChunkConverter });

function toUserBlocks(content: unknown): WireBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as WireBlock[]) : [];
}
