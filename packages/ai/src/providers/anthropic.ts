import type { AIMessageChunk } from "@my-agent-team/core";
import { normalizeProviderError, type Provider, type ProviderAuth } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";
import type { Message } from "@my-agent-team/message";

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

        const systemMsg = messages.find((m) => m.role === "system");

        // Convert messages to Anthropic wire format.
        // Pattern from pi (packages/ai/src/api/anthropic-messages.ts):
        // look-ahead to merge consecutive `role: "tool"` messages into a
        // single `user(tool_result*)` message so strict validators (z.ai,
        // deepseek) that require all results in the message right after the
        // assistant(tool_use) batch accept the request.
        const wireMessages: Array<{ role: string; content: unknown }> = [];
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]!;
          if (m.role === "system") continue;

          if (m.role === "tool") {
            // Collect all consecutive tool messages into one user message.
            const toolResults: Array<Record<string, unknown>> = [];
            let j = i;
            for (; j < messages.length; j++) {
              const tm = messages[j]!;
              if (tm.role !== "tool") break;
              for (const b of tm.blocks ?? []) {
                if (b.type === "tool_result") {
                  toolResults.push({
                    type: "tool_result",
                    tool_use_id: b.tool_use_id,
                    content: b.content,
                  });
                }
              }
            }
            i = j - 1; // skip processed
            wireMessages.push({ role: "user", content: toolResults });
            continue;
          }

          // user / assistant: map blocks to wire content.
          if (m.blocks && m.blocks.length > 0) {
            const wireRole =
              m.role === "assistant" && m.blocks.some((b) => b.type === "tool_result")
                ? "assistant"
                : m.role;
            wireMessages.push({
              role: wireRole,
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
            });
          } else {
            wireMessages.push({ role: m.role, content: m.text ?? "" });
          }
        }

        const body = {
          model: model.id,
          max_tokens: model.maxTokens,
          messages: wireMessages,
          system: systemMsg?.text,
          stream: true,
          tools: opts?.tools?.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema ?? {},
          })),
        };

        const res = await fetch(`${url}/messages`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: opts?.signal,
        });
        if (!res.ok) {
          const errBody = await res.text().catch(() => "");
          throw new Error(`Anthropic error status=${res.status} ${errBody}`);
        }
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
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
        throw normalizeProviderError(err, secrets);
      }
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
