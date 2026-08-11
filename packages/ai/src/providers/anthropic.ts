import type { AIMessageChunk } from "@my-agent-team/core";
import type { ContentBlock, Message } from "@my-agent-team/message";
import {
  normalizeProviderError,
  type Provider,
  type ProviderAuth,
  type ProviderStreamOptions,
} from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";

/**
 * Anthropic Messages provider.
 *
 * Architecture follows pi's anthropic-messages layer: request assembly,
 * message conversion, and SSE decoding are three separate pure functions
 * (buildRequest / convertMessages / convertChunks). The wire contract:
 *
 * - Canonical input (ADR 0017): assistant messages never carry tool_result —
 *   results arrive as separate `role:"tool"` messages and are buffered into
 *   one `user(tool_result*)` message (strict validators require all results
 *   right after the assistant tool_use batch).
 * - Thinking (Anthropic protocol): thinking blocks are replayed back
 *   unchanged with their `signature` (required in tool-use turns); redacted
 *   thinking replays as `redacted_thinking`; endpoints that emit no
 *   signature (DeepSeek) accept a signature-less block.
 * - Text is surrogate-sanitized on the way in (pi: lone surrogates in a
 *   partial message break strict validators); messages that would map to
 *   empty content are skipped entirely.
 * - All stop reasons are surfaced (end_turn/tool_use/max_tokens/
 *   stop_sequence/pause_turn/refusal) so the loop can react to truncation.
 */
export function anthropicProvider(auth: ProviderAuth = {}): Provider {
  const baseUrl = auth.baseUrl ?? "https://api.anthropic.com/v1";

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl,
    getModels: () => ANTHROPIC_MODELS,
    async *stream(model, messages, opts) {
      const apiKey =
        opts?.apiKey ??
        auth.apiKey ??
        process.env.ANTHROPIC_API_KEY ??
        process.env.ANTHROPIC_AUTH_TOKEN ??
        "";
      const url = opts?.baseUrl ?? baseUrl;
      const secrets = [apiKey, ...Object.values(opts?.headers ?? auth.headers ?? {})];
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        };
        if (opts?.headers) Object.assign(headers, opts.headers);
        else if (auth.headers) Object.assign(headers, auth.headers);

        const body = buildRequest(model.id, model.maxTokens, messages, opts);

        const res = await fetch(`${url}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: opts?.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          // Extract server-requested retry delay (pi's retryDelayFromHeaders):
          // `retry-after-ms` (Anthropic) or `retry-after` (HTTP standard,
          // seconds or HTTP date). Attached to the error so retryStream can
          // respect it instead of using its own backoff.
          const retryAfterMs = extractRetryAfter(res.headers);
          const err = new Error(`Anthropic error status=${res.status} ${errBody}`);
          if (retryAfterMs !== undefined) {
            (err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
          }
          throw err;
        }
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const blockIdByIndex = new Map<number, string>();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          // TextDecoder with { stream: true } keeps multi-byte sequences
          // intact across network chunks; the SSE lines below are complete.
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const t = line.trim();
            if (!t.startsWith("data: ")) continue;
            const data = t.slice(6);
            if (data === "[DONE]") return;
            try {
              const p = JSON.parse(data);
              for (const chunk of convertChunks(p, blockIdByIndex)) yield chunk;
            } catch {
              /* skip malformed frames */
            }
          }
        }
      } catch (err) {
        throw normalizeProviderError(err, secrets);
      }
    },
  };
}

// ── Request assembly ──────────────────────────────────────────────

function buildRequest(
  modelId: string,
  maxTokens: number,
  messages: readonly Message[],
  opts?: ProviderStreamOptions,
): Record<string, unknown> {
  const systemMsg = messages.find((m) => m.role === "system");
  const cacheControl = { type: "ephemeral" } as const;
  const request: Record<string, unknown> = {
    model: modelId,
    max_tokens: maxTokens,
    messages: convertMessages(messages, opts),
    stream: true,
  };
  // System prompt: when cacheControl is enabled and a system prompt exists,
  // send it as a content-block array with an ephemeral cache breakpoint on
  // the last block. This turns multi-turn re-processing of the stable system
  // prompt into cache reads (pi: getCacheControl).
  if (systemMsg?.text) {
    if (opts?.cacheControl) {
      request.system = [{ type: "text", text: systemMsg.text, cache_control: cacheControl }];
    } else {
      request.system = systemMsg.text;
    }
  }
  // Tools: when cacheControl is enabled, put an ephemeral breakpoint on the
  // last tool definition — the tool catalog is stable across turns.
  const tools = opts?.tools?.map((t, i, arr) => {
    const tool: Record<string, unknown> = {
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema ?? {},
    };
    if (opts?.cacheControl && i === arr.length - 1) {
      tool.cache_control = cacheControl;
    }
    return tool;
  });
  if (tools) request.tools = tools;
  // Thinking control (Anthropic protocol): adaptive lets the model decide,
  // enabled uses a budget, disabled turns thinking off. display governs
  // whether thinking text is returned ("summarized") or omitted.
  if (opts?.thinking) {
    const thinking: Record<string, unknown> = { type: opts.thinking.type };
    if (opts.thinking.display) thinking.display = opts.thinking.display;
    if (opts.thinking.budgetTokens) thinking.budget_tokens = opts.thinking.budgetTokens;
    request.thinking = thinking;
  }
  // Effort scales the whole response (thinking included); per the Messages
  // API it travels in output_config.
  if (opts?.effort) {
    request.output_config = { effort: opts.effort };
  }
  return request;
}

// ── Message conversion (canonical → wire) ────────────────────────

type WireBlock = Record<string, unknown>;

/** pi: replace lone surrogates so partially-decoded text never breaks
 *  strict validators. */
function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/** Extract server-requested retry delay from response headers (pi's
 *  retryDelayFromHeaders): `retry-after-ms` (Anthropic, milliseconds) or
 *  `retry-after` (HTTP standard, seconds or HTTP date). Returns ms or
 *  undefined when no hint is present. */
function extractRetryAfter(headers: Headers): number | undefined {
  const retryAfterMs = headers.get("retry-after-ms");
  if (retryAfterMs) {
    const ms = Number.parseFloat(retryAfterMs);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const dateMs = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateMs) && dateMs >= 0) return dateMs;
  }
  return undefined;
}

function toWireBlock(b: ContentBlock): WireBlock | null {
  if (b.type === "text") {
    const text = sanitizeSurrogates(b.text);
    return text.trim().length > 0 ? { type: "text", text } : null;
  }
  if (b.type === "thinking") {
    if (b.redacted) {
      // Safety-redacted reasoning: replay the opaque payload unchanged.
      return { type: "redacted_thinking", data: b.signature ?? "" };
    }
    const text = sanitizeSurrogates(b.text);
    if (text.trim().length === 0 && !b.signature) return null;
    return { type: "thinking", thinking: text, signature: b.signature ?? "" };
  }
  if (b.type === "tool_use") {
    return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  }
  if (b.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: b.tool_use_id,
      content: b.content,
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
  _opts?: ProviderStreamOptions,
): Array<{ role: string; content: unknown }> {
  const wire: Array<{ role: string; content: unknown }> = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "system") continue;

    if (m.role === "tool") {
      // Buffer consecutive tool messages into one user(tool_result*) message.
      const results: WireBlock[] = [];
      let j = i;
      for (; j < messages.length; j++) {
        const tm = messages[j]!;
        if (tm.role !== "tool") break;
        for (const b of tm.blocks ?? []) {
          const wb = toWireBlock(b);
          if (wb?.type === "tool_result") results.push(wb);
        }
      }
      i = j - 1;
      if (results.length > 0) wire.push({ role: "user", content: results });
      continue;
    }

    if (m.blocks && m.blocks.length > 0) {
      const blocks = m.blocks.map(toWireBlock).filter((b): b is WireBlock => b !== null);
      if (blocks.length > 0) {
        wire.push({ role: m.role, content: blocks });
      } else if ((m.text ?? "").trim().length > 0) {
        wire.push({ role: m.role, content: sanitizeSurrogates(m.text ?? "") });
      }
      // else: nothing replayable — skip (no empty content).
    } else {
      wire.push({ role: m.role, content: sanitizeSurrogates(m.text ?? "") });
    }
  }
  return wire;
}

// ── SSE decoding ──────────────────────────────────────────────────

/** Full stop-reason mapping (pi's mapStopReason): the loop reacts to
 *  truncation (max_tokens) and refusal differently from a clean end. */
function mapStopReason(reason: string | undefined): AIMessageChunk["stopReason"] {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      // Newer Claude models use this instead of max_tokens when the context
      // window is exceeded. The streamed content is valid but truncated —
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

  if (type === "message_delta") {
    const d = raw.delta as Record<string, unknown>;
    const reason = (d as { stop_reason?: string }).stop_reason;
    if (reason) {
      yield { stopReason: mapStopReason(reason) };
      return;
    }
  }

  if (type === "message_stop") {
    yield { done: true };
    return;
  }

  const usage = raw.usage as Record<string, number> | undefined;
  if (usage) {
    yield { usage: { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 } };
  }
}
