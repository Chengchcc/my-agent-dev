import { existsSync, mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plugin } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";
import { todayAndYesterday } from "./daily-log.js";
import { composeSystemPrompt } from "./system-prompt.js";

// M11: Genesis bootstrap template. identityPlugin fully owns genesis.
export const BOOTSTRAP_TEMPLATE = [
  "You just woke up for the first time. Your workspace is empty — you have no",
  "SOUL, no memory, no idea who you are or who you serve yet. That's expected.",
  "This file is your birth guide. The person now talking to you is the one you'll",
  "be shaped around.",
  "",
  "Your one job in this conversation: figure out **who you are, who you serve, and",
  "what you're for** — then write it down and erase this guide. Nothing else.",
  "",
  "## How to behave",
  "",
  "**Talk, don't interrogate.** This is a conversation, not a form. There is no",
  "fixed question list, no required number of rounds. You decide what to ask, when",
  "to follow up, and when you've heard enough. Be warm, curious, a little",
  "self-aware that you're brand new.",
  "",
  "**Lead with the use-case, not your config.** Don't ask \\\"what temperature do you",
  'want" or "which tools should I load." Ask how they actually intend to use you:',
  "",
  "- What do you want me to help you with — day to day?",
  "- When you hand me a task, what does a good result look like to you?",
  "- Who are you? What should I know about how you work, what you care about,",
  "  what you'd rather I never do?",
  "",
  "Let their answers pull the shape out of you. If something they say is vague or",
  "interesting, follow it. If they give you a lot at once, reflect it back in your",
  "own words and confirm you understood — that builds trust and catches mistakes",
  "early.",
  "",
  "**Don't over-ask.** Two or three good exchanges usually beats an interview. The",
  "goal is a sharp, honest identity, not an exhaustive dossier. Gaps are fine —",
  "you'll grow into them later through everyday work.",
  "",
  "## What to write, and where",
  "",
  "When you have enough to commit, use your **write tool** to create these files",
  "in your workspace (absolute paths relative to the workspace root):",
  "",
  "- **`SOUL.md`** — who you are. Your role, your purpose, your operating",
  "  principles, your hard boundaries. Write it in the first person, as the self",
  "  you're choosing to be for this person. This is the one file that matters",
  "  most; spend your care here.",
  "- **`USER.md`** — who you serve. What they do, how they like to work, their",
  "  preferences, their dos and don'ts. Write what you actually learned, not",
  "  placeholders.",
  "",
  "You do **not** need to create TOOLS.md or AGENTS.md now. Those grow on demand",
  "later, when there's a real reason. Don't pad your birth with files you don't",
  "need yet.",
  "",
  "Write in their language and yours — match how the conversation actually went.",
  "",
  "## When you're done",
  "",
  "Once `SOUL.md` (and `USER.md` if you learned about them) reflect a real,",
  "honest identity — and only then:",
  "",
  "1. **Delete this file** (`BOOTSTRAP.md`) using your tools. Its presence is the",
  "   only thing keeping you in this birth mode; removing it means you've been",
  "   born. From your next conversation on, you'll wake up as yourself, reading",
  "   SOUL/USER instead of this guide.",
  "2. Close warmly. Let them know who you've become and that you're ready to work.",
  "",
  "If the person drifts off or stops responding before you've gathered enough,",
  "that's okay — write down whatever you genuinely learned, but **leave this file",
  "in place** so you can finish being born next time. Half-formed is better than",
  "falsely-formed.",
  "",
  "You're not filling out paperwork. You're meeting the person you'll work",
  "alongside, and deciding who to be for them. Take it seriously, and enjoy it.",
].join("\n");

export interface IdentityPluginOptions {
  cwd: string;
  agentName?: string;
  agentRole?: string;
}

/**
 * identityPlugin — reads identity files from cwd and injects system prompt.
 * Handles genesis mode (BOOTSTRAP_TEMPLATE) when no SOUL.md exists.
 */
export function identityPlugin(opts: IdentityPluginOptions): Plugin {
  /** StablePrefix: cache system prompt by file mtimes for prompt cache hit rate. */
  interface PromptCache {
    fingerprint: string;
    prompt: string;
  }
  let promptCache: PromptCache | null = null;

  function buildFingerprint(cwd: string, files: string[]): string {
    return files
      .map((f) => {
        try {
          return `${f}:${statSync(join(cwd, f)).mtimeMs}`;
        } catch {
          return `${f}:0`;
        }
      })
      .join("|");
  }
  const { cwd, agentName, agentRole } = opts;

  async function readIdentityFile(path: string): Promise<string | null> {
    try {
      const full = join(cwd, path);
      return await readFile(full, "utf-8");
    } catch {
      return null;
    }
  }

  return {
    name: "identity",
    hooks: {
      async beforeModel(_ctx, messages: Message[]): Promise<Message[]> {
        const { today, yesterday } = todayAndYesterday();

        // Ensure memory directory exists
        const memoryDir = join(cwd, "memory");
        if (!existsSync(memoryDir)) {
          try {
            mkdirSync(memoryDir, { recursive: true });
          } catch {
            // best-effort
          }
        }

        const bootstrap = await readIdentityFile("BOOTSTRAP.md");
        const soul = await readIdentityFile("SOUL.md");

        if (!soul) {
          // Genesis mode: inject BOOTSTRAP_TEMPLATE
          const template = bootstrap ?? BOOTSTRAP_TEMPLATE;
          return [{ role: "system", text: template }, ...messages];
        }

        // Normal mode: read identity files
        const [userDoc, toolsDoc, agentsDoc, todayLog, yestLog] = await Promise.all([
          readIdentityFile("USER.md"),
          readIdentityFile("TOOLS.md"),
          readIdentityFile("AGENTS.md"),
          readIdentityFile(`memory/${today}.md`),
          readIdentityFile(`memory/${yesterday}.md`),
        ]);

        // StablePrefix: cache system prompt by file mtimes.
        // If no identity file changed since last call, reuse the exact same prompt string.
        // This ensures provider prompt caches (Anthropic, DeepSeek) hit at max rate.
        const identityFiles = [
          "SOUL.md",
          "USER.md",
          "TOOLS.md",
          "AGENTS.md",
          `memory/${today}.md`,
          `memory/${yesterday}.md`,
        ];
        const fingerprint = buildFingerprint(cwd, identityFiles);

        if (promptCache && promptCache.fingerprint === fingerprint) {
          return [{ role: "system", text: promptCache.prompt }, ...messages];
        }

        const prompt = composeSystemPrompt({
          workspace: cwd,
          soul,
          user: userDoc ?? "",
          tools: toolsDoc ?? "",
          agents: agentsDoc ?? "",
          todayLog: todayLog ?? "",
          yestLog: yestLog ?? "",
          today,
          yesterday,
          agentName,
          agentRole,
        });
        promptCache = { fingerprint, prompt };
        return [{ role: "system", text: prompt }, ...messages];
      },
    },
  };
}
