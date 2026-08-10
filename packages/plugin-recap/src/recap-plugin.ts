import type { Plugin, PluginRuntime } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";

export interface RecapPluginOptions {
  /** Model to use for recap generation (provider/model id). */
  readonly recapModelRef: { readonly providerId: string; readonly modelId: string };
  /** When false, the plugin is a no-op. */
  readonly enabled: boolean;
}

const RECAP_SYSTEM_PROMPT =
  "Summarize the conversation so far in one sentence. Focus on what was just done and the current state. Be concise and specific. Output ONLY the summary sentence, nothing else.";

/** Create a recap plugin that generates a one-sentence per-turn summary
 *  using a cheap model. The summary is emitted as a UI-transient event
 *  (recap_update) — never persisted to conversation history. */
export function createRecapPlugin(opts: RecapPluginOptions): Plugin {
  let turnCount = 0;

  return {
    name: "recap",
    hooks: {
      afterModel(messages: readonly Message[], rt: PluginRuntime): void {
        if (!opts.enabled) return;
        turnCount++;
        // Fire-and-forget: the recap must not block the main loop.
        void generateRecap(rt, messages, opts.recapModelRef, turnCount);
      },
    },
  };
}

async function generateRecap(
  rt: PluginRuntime,
  messages: readonly Message[],
  modelRef: { readonly providerId: string; readonly modelId: string },
  turn: number,
): Promise<void> {
  try {
    const recapMessages: Message[] = [{ role: "system", text: RECAP_SYSTEM_PROMPT }, ...messages];
    let text = "";
    for await (const chunk of rt.streamModel(modelRef.providerId, modelRef.modelId, recapMessages, {
      signal: rt.signal,
    })) {
      if (rt.signal.aborted) return;
      if (chunk.delta?.type === "text") text += chunk.delta.text;
    }
    const trimmed = text.trim();
    if (trimmed) {
      rt.emit({ type: "recap_update", text: trimmed, turn });
    }
  } catch {
    // Recap is best-effort; never fail the run.
  }
}
