import type { Model, Provider } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

/** Deterministic fake Provider for daemon integration tests. Yields one text
 *  chunk then a natural stop - no network, no credentials. Registered by the
 *  Worker when CODING_AGENT_FAKE_PROVIDER=1 is in its env. */

const FAKE_MODEL: Model = {
  id: "echo",
  name: "Fake Echo",
  provider: "fake",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

export function fakeProvider(): Provider {
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(_model: Model, _messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text: "done" } };
      yield { stopReason: "end_turn" };
    },
  };
}
