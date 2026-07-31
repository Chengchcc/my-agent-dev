import type { AIMessageChunk } from "@my-agent-team/core";
import { type Model, normalizeProviderError, type Provider, type ProviderAuth } from "../types.js";

export interface OpenAICompatProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}

export function createOpenAICompatProvider(config: OpenAICompatProviderConfig): Provider {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    getModels: () => config.models,
    async *stream(model, messages, opts) {
      // Credentials resolved per request: opts override provider defaults.
      const apiKey = opts?.apiKey ?? config.auth.apiKey ?? "";
      const baseUrl = opts?.baseUrl ?? config.baseUrl;
      const secrets = [apiKey, ...Object.values(opts?.headers ?? config.auth.headers ?? {})];
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        };
        if (opts?.headers) Object.assign(headers, opts.headers);
        else if (config.auth.headers) Object.assign(headers, config.auth.headers);

        const body = {
          model: model.id,
          messages: messages.map((m) => {
            if (m.blocks && m.blocks.length > 0) {
              const toolCalls = m.blocks
                .filter((b) => b.type === "tool_use")
                .map((b, _i) => ({
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
          tools: opts?.tools?.map((t) => ({
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
          signal: opts?.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`OpenAI error status=${res.status} ${errBody}`);
        }
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
        throw normalizeProviderError(err, secrets);
      }
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
