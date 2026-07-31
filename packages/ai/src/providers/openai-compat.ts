import type { AIMessageChunk, ChatModel } from "@my-agent-team/core";
import { type Model, type Provider, type ProviderAuth, ProviderError } from "../types.js";

export interface OpenAICompatProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}

function normalizeError(err: unknown): ProviderError {
  const msg = err instanceof Error ? err.message : String(err);
  const s = msg.match(/status[= ](\d+)/);
  const code = s ? Number(s[1]) : undefined;
  if (code === 401 || code === 403)
    return new ProviderError(msg, "auth", { statusCode: code, raw: err });
  if (code === 400 || code === 422)
    return new ProviderError(msg, "invalid_request", { statusCode: code, raw: err });
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

export function createOpenAICompatProvider(config: OpenAICompatProviderConfig): Provider {
  const cache = new Map<string, ChatModel>();

  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    getModels: () => config.models,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const modelKey = `${model.id}:${opts?.baseUrl ?? config.baseUrl}`;
      let instance = cache.get(modelKey);
      if (!instance) {
        const apiKey = opts?.apiKey ?? config.auth.apiKey ?? "";
        const baseUrl = opts?.baseUrl ?? config.baseUrl;
        instance = {
          id: model.id,
          async *stream(messages, options) {
            try {
              const headers: Record<string, string> = {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              };
              if (opts?.headers) Object.assign(headers, opts.headers);

              const body = {
                model: model.id,
                messages: messages.map((m) => {
                  if (m.blocks && m.blocks.length > 0) {
                    const toolCalls = m.blocks
                      .filter((b) => b.type === "tool_use")
                      .map((b, i) => ({
                        id: b.id,
                        type: "function" as const,
                        function: { name: b.name, arguments: JSON.stringify(b.input) },
                      }));
                    const textBlocks = m.blocks
                      .filter((b) => b.type === "text")
                      .map((b) => b.text)
                      .join("");
                    const resultBlock = m.blocks.find((b) => b.type === "tool_result");
                    if (resultBlock) {
                      return {
                        role: "tool",
                        tool_call_id: resultBlock.tool_use_id,
                        content: resultBlock.content,
                      };
                    }
                    if (toolCalls.length > 0) {
                      return { role: m.role, content: textBlocks || null, tool_calls: toolCalls };
                    }
                    return { role: m.role, content: (textBlocks || m.text) ?? "" };
                  }
                  return { role: m.role, content: m.text ?? "" };
                }),
                max_tokens: model.maxTokens,
                stream: true,
                stream_options: { include_usage: true },
                tools: options?.tools?.map((t) => ({
                  type: "function",
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema ?? {},
                  },
                })),
              };

              const res = await fetch(`${baseUrl}/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: options?.signal,
              });
              if (!res.ok) throw new Error(`OpenAI error status=${res.status}`);
              if (!res.body) throw new Error("No response body");

              const reader = res.body.getReader();
              const dec = new TextDecoder();
              let buf = "";
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                for (const line of buf.split("\n")) {
                  const t = line.trim();
                  if (!t.startsWith("data: ")) continue;
                  const data = t.slice(6);
                  if (data === "[DONE]") return;
                  try {
                    const p = JSON.parse(data);
                    for (const c of convertChunk(p)) yield c;
                  } catch {
                    /* skip */
                  }
                }
                buf = "";
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

function* convertChunk(raw: Record<string, unknown>): Generator<AIMessageChunk> {
  const choices = raw.choices as Array<Record<string, unknown>> | undefined;
  if (choices?.[0]) {
    const delta = choices[0].delta as Record<string, unknown> | undefined;
    if (delta?.content) yield { delta: { type: "text", text: delta.content as string } };
    if (delta?.tool_calls) {
      const tc = (delta.tool_calls as Array<Record<string, unknown>>)[0];
      if (tc)
        yield {
          delta: {
            type: "tool_use",
            id: (tc.id as string) ?? "",
            name: ((tc.function as Record<string, unknown>)?.name as string) ?? "",
          },
        };
    }
    if (choices[0].finish_reason) {
      const fr = choices[0].finish_reason as string;
      if (fr === "tool_calls") yield { stopReason: "tool_use" };
      else if (fr === "stop") yield { stopReason: "end_turn" };
    }
  }
  const usage = raw.usage as Record<string, number> | undefined;
  if (usage)
    yield { usage: { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 } };
}
