import { describe, expect, test } from "bun:test";
import type { Tool, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import { createContextStore } from "../context/context.js";
import { passthroughContextManager } from "../context/passthrough.js";
import { inMemoryCheckpointer } from "../persistence/in-memory.js";
import { consoleLogger } from "./logger.js";
import { definePlugin, type HookContext, validatePlugins } from "./plugin.js";

function getError(fn: () => void): Error {
  try {
    fn();
    throw new Error("Expected function to throw");
  } catch (e) {
    return e as Error;
  }
}

function testCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    sessionId: "t1",
    logger: consoleLogger({ level: "silent" }),
    messageStore: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
    context: createContextStore(),
    ...overrides,
  };
}

describe("definePlugin", () => {
  test("creates a plugin with the given name", () => {
    const plugin = definePlugin({
      name: "test-plugin",
      hooks: {},
    });

    expect(plugin.name).toBe("test-plugin");
    expect(plugin.hooks).toEqual({});
  });

  test("preserves hook functions", () => {
    const beforeModel = (_ctx: HookContext, msgs: readonly Message[]) => [...msgs];
    const afterModel = () => {};

    const plugin = definePlugin({
      name: "test",
      hooks: { beforeModel, afterModel },
    });

    expect(plugin.hooks.beforeModel).toBe(beforeModel);
    expect(plugin.hooks.afterModel).toBe(afterModel);
    expect(plugin.hooks.beforeTool).toBeUndefined();
    expect(plugin.hooks.afterTool).toBeUndefined();
  });

  test("passes ctx and messages to hooks", async () => {
    let capturedCtx: unknown;
    let capturedMsgs: unknown;

    const plugin = definePlugin({
      name: "capture",
      hooks: {
        afterModel(ctx, msgs) {
          capturedCtx = ctx;
          capturedMsgs = msgs;
        },
      },
    });

    const ctx = testCtx();
    const msgs: Message[] = [{ role: "user", text: "hi" }];
    await plugin.hooks.afterModel?.(ctx, msgs);

    expect(capturedCtx).toHaveProperty("sessionId", "t1");
    expect(capturedCtx).toHaveProperty("logger");
    expect(capturedCtx).toHaveProperty("messageStore");
    expect(capturedCtx).toHaveProperty("contextManager");
    expect(capturedMsgs).toBe(msgs);
  });

  test("beforeTool can return skip with result", async () => {
    const plugin = definePlugin({
      name: "guard",
      hooks: {
        beforeTool() {
          return { skip: true, result: "not allowed" };
        },
      },
    });

    const call: ToolUseBlock = { type: "tool_use", id: "t1", name: "write", input: {} };
    const result = await plugin.hooks.beforeTool?.(testCtx(), call, []);

    expect(result).toEqual({ skip: true, result: "not allowed" });
  });

  test("definePlugin preserves tools field", () => {
    const tools: readonly Tool[] = [
      { name: "t1", description: "", inputSchema: {}, execute: () => ({ content: "ok" }) },
    ];

    const plugin = definePlugin({
      name: "with-tools",
      hooks: {},
      tools,
    });

    expect(plugin.tools).toBe(tools);
    expect(plugin.tools).toHaveLength(1);
  });

  test("definePlugin without tools has undefined tools", () => {
    const plugin = definePlugin({ name: "no-tools", hooks: {} });
    expect(plugin.tools).toBeUndefined();
  });
});

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: () => ({ content: "ok" }) };
}

describe("validatePlugins", () => {
  test("returns merged tools from config and plugins", () => {
    const configTools: readonly Tool[] = [makeTool("config_a")];
    const plugins = [
      definePlugin({ name: "p1", hooks: {}, tools: [makeTool("p1_a")] }),
      definePlugin({ name: "p2", hooks: {}, tools: [makeTool("p2_a")] }),
    ];

    const merged = validatePlugins(plugins, configTools);
    expect(merged.map((t) => t.name)).toEqual(["config_a", "p1_a", "p2_a"]);
  });

  test("works with only config tools", () => {
    const merged = validatePlugins([], [makeTool("a"), makeTool("b")]);
    expect(merged.map((t) => t.name)).toEqual(["a", "b"]);
  });

  test("works with only plugin tools", () => {
    const plugins = [definePlugin({ name: "p1", hooks: {}, tools: [makeTool("x")] })];
    const merged = validatePlugins(plugins);
    expect(merged.map((t) => t.name)).toEqual(["x"]);
  });

  test("works with empty plugins and empty config", () => {
    const merged = validatePlugins([]);
    expect(merged).toEqual([]);
  });

  test("plugin without tools field is ignored", () => {
    const plugins = [
      definePlugin({ name: "no-tools", hooks: {} }),
      definePlugin({ name: "with-tools", hooks: {}, tools: [makeTool("good")] }),
    ];
    const merged = validatePlugins(plugins, []);
    expect(merged.map((t) => t.name)).toEqual(["good"]);
  });

  test("throws on collision between config and plugin tool", () => {
    const plugins = [definePlugin({ name: "my-plugin", hooks: {}, tools: [makeTool("read")] })];

    expect(() => validatePlugins(plugins, [makeTool("read")])).toThrow(
      /Tool name collision.*read.*config\.tools.*my-plugin/,
    );
  });

  test("throws on collision between two plugins", () => {
    const plugins = [
      definePlugin({ name: "alpha", hooks: {}, tools: [makeTool("shared")] }),
      definePlugin({ name: "beta", hooks: {}, tools: [makeTool("shared")] }),
    ];

    expect(() => validatePlugins(plugins, [])).toThrow(/Tool name collision.*shared.*alpha.*beta/);
  });

  test("error message names both collision sources", () => {
    const plugins = [definePlugin({ name: "collider", hooks: {}, tools: [makeTool("boom")] })];
    const err = getError(() => validatePlugins(plugins, [makeTool("boom")]));
    expect(err.message).toMatch(/boom/);
    expect(err.message).toMatch(/config\.tools/);
    expect(err.message).toMatch(/collider/);
  });
});
