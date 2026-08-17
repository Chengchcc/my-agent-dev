import type { Plugin, PluginRuntime } from "@chengchenccc/agent";
import { extractText, type Message } from "@chengchenccc/message";

export interface RecapPluginOptions {
  /** Model to use for recap generation (provider/model id). */
  readonly recapModelRef: { readonly providerId: string; readonly modelId: string };
  /** When false, the plugin is a no-op. */
  readonly enabled: boolean;
}

/** Minimum conversation substance to warrant a recap. */
const MIN_CONTENT_CHARS = 100;

const RECAP_PROMPT = `You generate a recap for a user coming back to an ongoing conversation.

Rules:
- Output ONLY the recap text (1-2 plain sentences, under 40 words). No markdown, no labels.
- Lead with the overall goal, then the current task, then the one next action.
- Skip root-cause narrative, fix internals, and secondary details.
- If the conversation was trivial (greetings, simple Q&A, no real task), output exactly: (skip)
- Never repeat what the user already knows from their last message.`;

/** Create a recap plugin that generates a short summary of the Run after
 *  it completes. Uses afterRun + runEphemeralTurn (side-channel model call
 *  that shares the session's prompt cache without persisting). Trivial
 *  conversations are skipped without a model call. */
export function createRecapPlugin(opts: RecapPluginOptions): Plugin {
  return {
    name: "recap",
    hooks: {
      async afterRun(status, messages, rt) {
        if (!opts.enabled || status !== "completed") return;
        const contentChars = messages
          .filter((m) => m.role === "user" || m.role === "assistant")
          .reduce((n, m) => n + extractText(m).length, 0);
        if (contentChars < MIN_CONTENT_CHARS) return;
        console.error(`[recap] afterRun triggered (${contentChars} chars), generating...`);
        await generateRecap(rt, messages);
      },
    },
  };
}

async function generateRecap(rt: PluginRuntime, _messages: readonly Message[]): Promise<void> {
  try {
    const ephemeral = rt.runEphemeralTurn;
    if (!ephemeral) return;
    const raw = await ephemeral(RECAP_PROMPT, { signal: rt.signal });
    console.error(`[recap] runEphemeralTurn done text=${raw.trim().slice(0, 80)}`);
    const trimmed = raw.trim();
    if (trimmed && !/^\(skip\)$/i.test(trimmed)) {
      console.error("[recap] emitted recap_update");
      rt.emit({ type: "recap_update", text: trimmed, turn: 0 });
      console.error("[recap] generateRecap completed");
    } else {
      console.error("[recap] model returned (skip), no recap emitted");
    }
  } catch (err) {
    console.error(
      `[recap] generateRecap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
