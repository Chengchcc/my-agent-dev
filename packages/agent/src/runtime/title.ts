import { extractText, type Message } from "@my-agent-team/message";
import type { PluginRuntime } from "./plugin-runtime.js";

// ── Low-signal pre-filter (deterministic, no model call) ──────────────────
// Absorbed from : greetings, single words, and
// pure filler are skipped without wasting a model call.

const TITLE_WORD = /\p{L}[\p{L}\p{N}_'-]*/gu;
const FILLER_TOKENS = new Set([
  "hi",
  "hey",
  "hello",
  "yo",
  "sup",
  "ok",
  "okay",
  "yes",
  "no",
  "yeah",
  "thanks",
  "thank",
  "thx",
  "bye",
  "lol",
  "haha",
  "wow",
  "cool",
  "nice",
  "great",
  "sure",
  "right",
  "please",
  "test",
  "ping",
  "你好",
  "在吗",
  "测试",
  "好的",
  "谢谢",
  "哈喽",
  "嗨",
]);

export function isLowSignalTitleInput(message: string): boolean {
  const tokens = message.toLowerCase().match(TITLE_WORD);
  if (!tokens) return true;
  return tokens.every((t) => FILLER_TOKENS.has(t) || /^\d+$/.test(t));
}

// ── Prompt XML tag format + few-shot ───────────────────────

const TITLE_SYSTEM_PROMPT = `Write a 3-7 word title for the task.

Answer with only the title inside <title> and </title> tags, nothing before or after.
If there is no concrete task (greeting, small talk, acknowledgment), output exactly: <title>none</title>
Capitalize only the first word and proper names.

Examples:
User: the login button is broken on mobile, can you fix?
<title>Fix login button on mobile</title>

User: refactor error handling in the API client
<title>Refactor API error handling</title>

User: hey
<title>none</title>`;

// ── Normalization robust extraction ────────────────────────

const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;
const NO_TITLE_SENTINELS = new Set(["none", "（无）", "无"]);

export function normalizeGeneratedTitle(raw: string): string | null {
  const firstLine = raw.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  // Strip XML tags if present
  const title = firstLine
    .replace(/^<title>/i, "")
    .replace(/<\/title>$/i, "")
    .replace(/^["'「『]|["'」』]$/g, "")
    .replace(/[.!?。！？]$/, "")
    .trim();
  if (!title || NO_TITLE_SENTINELS.has(title.toLowerCase())) return null;
  // Reject overlong output (model answered instead of titling)
  if (title.length > MAX_TITLE_CHARS) return null;
  if ((title.match(TITLE_WORD)?.length ?? 0) > MAX_TITLE_WORDS) return null;
  return title;
}

// ── Context builder ───────────────────────────────────────────────────────

export function buildTitleContext(msgs: Message[], maxTurns = 4): string {
  return msgs
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(0, maxTurns * 2)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${extractText(m)}`)
    .filter((line) => line.length > 3)
    .join("\n");
}

// ── Title generation (uses runEphemeralTurn) ──────────────────────────────

export async function generateTitle(rt: PluginRuntime, context: string): Promise<string | null> {
  if (!context || context.length < 4) return null;
  if (isLowSignalTitleInput(context)) return null;
  try {
    const ephemeral = rt.runEphemeralTurn;
    if (!ephemeral) return null;
    const raw = await ephemeral(
      `${TITLE_SYSTEM_PROMPT}\n\n<conversation>\n${context}\n</conversation>`,
      { signal: rt.signal },
    );
    return normalizeGeneratedTitle(raw);
  } catch {
    return null;
  }
}
