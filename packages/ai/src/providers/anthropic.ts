import type { AIMessageChunk, ChatModel } from "@my-agent-team/core";
import { type Model, type Provider, type ProviderAuth, ProviderError } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";

function normalizeError(err: unknown): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  const s = msg.match(/status[= ](\d+)/);
  const code = s ? Number(s[1]) : undefined;
  // Context-length errors (400/422 with body mentioning limits) are overflow,
  // a distinct retryable-after-compaction category from invalid_request.
  if (code === 400 || code === 422) {
    if (/context|too long|maximum|overflow|token limit/i.test(msg)) {
      return new ProviderError(msg, "overflow", { statusCode: code, raw: err });
    }
    return new ProviderError(msg, "invalid_request", { statusCode: code, raw: err });
  }
  if (code === 401 || code === 403)
    return new ProviderError(msg, "auth", { statusCode: code, raw: err });
  if (code === 429) return new ProviderError(msg, "overload", { statusCode: code, raw: err });
  if (code !== undefined && code >= 500)
    return new ProviderError(msg, "transient", { statusCode: code, raw: err });
  if (
    msg.includes("fetch") ||
    msg.includes("network") ||
    msg.includes("ECONN") ||
    msg.includes("timeout")
  )
    return new ProviderError(msg, "transient", { raw: err });
  if (err instanceof DOMException && err.name === "AbortError")
    return new ProviderError(msg, "aborted", { raw: err });
  return new ProviderError(msg, "fatal", { raw: err });
}

export function anthropicProvider(auth: ProviderAuth = {}): Provider {
  const apiKey =
    auth.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  const baseUrl = auth.baseUrl ?? "https://api.anthropic.com/v1";
  const cache = new Map<string, ChatModel>();

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl,
    getModels: () => ANTHROPIC_MODELS,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const modelKey = `${model.id}:${opts?.baseUrl ?? baseUrl}`;
      let instance = cache.get(modelKey);
      if (!instance) {
        const key = opts?.apiKey ?? apiKey;
        const url = opts?.baseUrl ?? baseUrl;
        instance = {
          id: model.id,
          async *stream(messages, options) {
            try {
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
                "x-api-key": key,
                "anthropic-version": "2023-06-01",
              };
              if (opts?.headers) Object.assign(headers, opts.headers);

              const systemMsg = messages.find((m) => m.role === "system");
              const body = {
                model: model.id,
                max_tokens: model.maxTokens,
                messages: messages
                  .filter((m) => m.role !== "system")
                  .map((m) => {
                    if (m.blocks && m.blocks.length > 0) {
                      return {
                        role: m.role,
                        content: m.blocks.map((b) => {
                          if (b.type === "text") return { type: "text", text: b.text };
                          if (b.type === "tool_use")
                            return { type: "tool_use", id: b.id, name: b.name, input: b.input };
                          if (b.type === "tool_result")
                            return {
                              type: "tool_result",
                              tool_use_id: b.tool_use_id,
                              content: b.content,
                            };
                          return { type: "text", text: "" };
                        }),
                      };
                    }
                    return { role: m.role, content: m.text ?? "" };
                  }),
                system: systemMsg?.text,
                stream: true,
                tools: options?.tools?.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema ?? {},
                })),
              };

              const res = await fetch(`${url}/messages`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: options?.signal,
              });
              if (!res.ok) {
                const errBody = await res.text().catch(() => "");
                throw new Error(`Anthropic error status=${res.status} ${errBody}`);
              }
              if (!res.body) throw new Error("No response body");

              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              // Track content block index → tool_use ID for input_json_delta pairing
              const blockIdByIndex = new Map<number, string>();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
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
                    /* skip */
                  }
                }
              }
            } catch (err) {
              throw normalizeError(err);
            }
          },
        };
        cache.set(modelKey, instance);
      }
      return instance;
    },
  };
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
    return;
  }

  if (type === "content_block_delta") {
    const d = raw.delta as Record<string, unknown>;
    if (d?.type === "text_delta") {
      yield { delta: { type: "text", text: (d.text as string) ?? "" } };
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
    if ((d as { stop_reason?: string }).stop_reason === "tool_use") {
      yield { stopReason: "tool_use" };
      return;
    }
    if ((d as { stop_reason?: string }).stop_reason === "end_turn") {
      yield { stopReason: "end_turn" };
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
