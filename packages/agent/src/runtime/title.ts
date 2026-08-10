import type { AIMessageChunk } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";
import type { PluginRuntime } from "./plugin-runtime.js";

const TITLE_SYSTEM =
  "你是一个会话标题生成器。阅读用户与助手的前几轮对话，输出一个不超过12个字的简短中文标题，" +
  "概括会话主题。只输出标题本身，不要引号、标点结尾或任何解释。";

export function buildTitleContext(msgs: Message[], maxTurns = 4): string {
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, maxTurns * 2)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${extractText(m)}`)
    .filter((line) => line.length > 3)
    .join("\n");
}

export function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'「『]|["'」』]$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

export async function generateTitle(
  rt: PluginRuntime,
  providerId: string,
  modelId: string,
  context: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!context || context.length < 4) return null;
  try {
    let text = "";
    for await (const chunk of rt.streamModel(
      providerId,
      modelId,
      [
        { role: "system", text: TITLE_SYSTEM },
        { role: "user", text: context },
      ],
      { signal },
    )) {
      if (signal?.aborted) return null;
      if (chunk.delta?.type === "text") text += chunk.delta.text;
    }
    const title = sanitizeTitle(text);
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}
