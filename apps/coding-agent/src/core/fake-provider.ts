import type { Model, Provider } from "@my-agent-team/ai";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

/** Deterministic fake Provider for daemon integration tests. Yields one text
 *  chunk then a natural stop - no network, no credentials. Registered by the
 *  Worker when CODING_AGENT_FAKE_PROVIDER=1 is in its env.
 *
 *  Scripted tool calls: when CODING_AGENT_FAKE_TOOL is set to a JSON array of
 *  `{ name, input }`, the provider emits one tool_use (with a deterministic
 *  model tool-use id) per stream call until the script is exhausted, then
 *  falls back to text. This lets full-stack tests drive real tool execution
 *  (Product Tools, todo_write) through the real Worker loop. */

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

let toolUseSeq = 0;

export function fakeProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Provider {
  let script: Array<{ name: string; input: Record<string, unknown> }> = [];
  try {
    const raw = env.CODING_AGENT_FAKE_TOOL;
    if (raw) script = JSON.parse(raw);
  } catch {
    script = [];
  }
  return {
    id: "fake",
    name: "Fake",
    getModels: () => [FAKE_MODEL],
    async *stream(_model: Model, _messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const next = script.shift();
      if (next) {
        const id = `toolu-fake-${++toolUseSeq}`;
        yield { delta: { type: "tool_use", id, name: next.name } };
        yield {
          delta: { type: "input_json_delta", id, partial_json: JSON.stringify(next.input) },
        };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "tool_use" };
        return;
      }
      yield { delta: { type: "text", text: "done" } };
      yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
      yield { stopReason: "end_turn" };
    },
  };
}
