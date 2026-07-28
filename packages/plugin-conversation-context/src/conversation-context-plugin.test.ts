import { describe, expect, test } from "bun:test";
import { createAgent, createContextStore } from "@my-agent-team/agent";
import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import {
  type ConversationContext,
  ConversationCtx,
  conversationContextPlugin,
} from "./conversation-context-plugin.js";

function echoModel(text: string): ChatModel {
  return {
    id: "echo",
    async *stream(): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text } };
      yield { done: true, stopReason: "end_turn" };
    },
  };
}

const dummyTool: Tool = {
  name: "test_tool",
  description: "A test tool",
  inputSchema: { type: "object", properties: {} },
  execute: () => ({ content: "ok" }),
};

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

describe("conversationContextPlugin", () => {
  test("registers tools on the agent", async () => {
    const plugin = conversationContextPlugin({
      tools: [dummyTool],
    });

    expect(plugin.name).toBe("conversation-context");
    expect(plugin.tools).toHaveLength(1);
    expect(plugin.tools![0]!.name).toBe("test_tool");
  });

  test("injects conversation context from ctx.data before model call", async () => {
    const plugin = conversationContextPlugin({ tools: [] });

    const agent = await createAgent({
      model: echoModel("hello"),
      plugins: [plugin],
    });

    const conv: ConversationContext = {
      id: "conv-1",
      surface: "web",
      senderName: "alice",
      input: "hi",
    };

    const events = await collect(
      agent.run("hi", {
        context: (() => {
          const s = createContextStore();
          s.set(ConversationCtx, conv);
          return s;
        })(),
      }),
    );
    const messages = events.filter((e) => e.type === "message");
    expect(messages.length).toBeGreaterThan(0);
    const doneMsg = messages.find((m) => m.payload.state === "done");
    expect(doneMsg).toBeDefined();
  });

  test("does not inject when context is empty", async () => {
    const plugin = conversationContextPlugin({ tools: [] });

    const agent = await createAgent({
      model: echoModel("ok"),
      plugins: [plugin],
    });

    // No conversation opts — plugin should pass messages through unchanged
    await collect(agent.run("test"));
    expect(agent.thread.messages.length).toBeGreaterThan(0);
  });

  test("does not require any tools", async () => {
    const plugin = conversationContextPlugin({ tools: [] });

    const agent = await createAgent({
      model: echoModel("ok"),
      plugins: [plugin],
    });

    await collect(
      agent.run("test", {
        context: (() => {
          const s = createContextStore();
          s.set(ConversationCtx, { id: "c1", surface: "web", senderName: "test", input: "test" });
          return s;
        })(),
      }),
    );
    expect(agent.thread.messages.length).toBeGreaterThan(0);
  });
});
