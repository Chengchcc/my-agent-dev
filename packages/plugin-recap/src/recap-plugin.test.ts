import { describe, expect, test } from "bun:test";
import type { CodingAgentLoopEvent, PluginRuntime } from "@my-agent-team/agent";
import type { AIMessageChunk } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import { createRecapPlugin } from "./recap-plugin.js";

function mockRuntime(streamText: string): {
  rt: PluginRuntime;
  emitted: CodingAgentLoopEvent[];
} {
  const emitted: CodingAgentLoopEvent[] = [];
  const rt: PluginRuntime = {
    async *streamModel() {
      yield { delta: { type: "text", text: streamText } } as AIMessageChunk;
      yield { stopReason: "end_turn" } as AIMessageChunk;
    },
    store: {} as never,
    sessionId: "test",
    workspaceRoot: "/ws",
    emit: (e) => {
      emitted.push(e);
    },
    signal: new AbortController().signal,
  };
  return { rt, emitted };
}

describe("plugin-recap", () => {
  test("afterRun emits recap_update with one-line summary", async () => {
    const plugin = createRecapPlugin({
      recapModelRef: { providerId: "fake", modelId: "echo" },
      enabled: true,
    });
    const { rt, emitted } = mockRuntime("Implemented JWT login.");
    const messages: Message[] = [
      { role: "user", text: "add auth" },
      { role: "assistant", text: "done" },
    ];

    plugin.hooks?.afterRun?.("completed", messages, rt);
    await new Promise((r) => setTimeout(r, 50));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe("recap_update");
    expect((emitted[0] as { text: string }).text).toBe("Implemented JWT login.");
  });

  test("disabled plugin is a no-op", async () => {
    const plugin = createRecapPlugin({
      recapModelRef: { providerId: "fake", modelId: "echo" },
      enabled: false,
    });
    const { rt, emitted } = mockRuntime("should not appear");

    plugin.hooks?.afterRun?.("completed", [], rt);
    await new Promise((r) => setTimeout(r, 50));

    expect(emitted).toHaveLength(0);
  });

  test("skips recap on failed/stopped runs", async () => {
    const plugin = createRecapPlugin({
      recapModelRef: { providerId: "fake", modelId: "echo" },
      enabled: true,
    });
    const { rt, emitted } = mockRuntime("should not appear");

    plugin.hooks?.afterRun?.("failed", [], rt);
    plugin.hooks?.afterRun?.("stopped", [], rt);
    await new Promise((r) => setTimeout(r, 50));

    expect(emitted).toHaveLength(0);
  });

  test("empty model output does not emit", async () => {
    const plugin = createRecapPlugin({
      recapModelRef: { providerId: "fake", modelId: "echo" },
      enabled: true,
    });
    const { rt, emitted } = mockRuntime("  ");

    plugin.hooks?.afterRun?.("completed", [], rt);
    await new Promise((r) => setTimeout(r, 50));

    expect(emitted).toHaveLength(0);
  });
});
