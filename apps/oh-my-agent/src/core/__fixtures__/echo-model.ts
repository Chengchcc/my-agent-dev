import type { AIMessageChunk } from "@chengchenccc/message";

/** Deterministic scripted model stream: yields one assistant text chunk, a
 *  usage record, and end_turn - the minimal shape the agent loop needs to
 *  complete a turn. */
export function createEchoModelStream(text: string): () => AsyncIterable<AIMessageChunk> {
  return async function* () {
    yield { delta: { type: "text", text } } as AIMessageChunk;
    yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } } as AIMessageChunk;
    yield { stopReason: "end_turn" } as AIMessageChunk;
  };
}
