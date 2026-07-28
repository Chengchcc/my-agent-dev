import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { AgentContext, AgentHooks } from "./agent-hooks.js";
import type { HookContext, Plugin } from "./runtime/plugin.js";
import { definePlugin } from "./runtime/plugin.js";

export function createHookPlugin(hooks: AgentHooks, agentCtx: AgentContext): Plugin {
  const fw: Record<string, unknown> = {};

  if (hooks["before:run"]) {
    const fn = hooks["before:run"];
    fw.beforeRun = (_ctx: HookContext, msgs: readonly Message[]) => {
      const result = fn(agentCtx, { text: "" });
      return result instanceof Promise ? msgs : [...msgs];
    };
  }
  if (hooks["before:model"]) {
    const fn = hooks["before:model"];
    fw.beforeModel = (_ctx: HookContext, msgs: readonly Message[]) => fn(agentCtx, msgs);
  }

  if (hooks["after:model"]) {
    const fn = hooks["after:model"];
    fw.afterModel = (_ctx: HookContext, msgs: readonly Message[]) =>
      fn(agentCtx, msgs, { input: 0, output: 0 });
  }

  if (hooks["before:tool"]) {
    const fn = hooks["before:tool"];
    fw.beforeTool = (_ctx: HookContext, call: ToolUseBlock, _msgs: readonly Message[]) =>
      fn(agentCtx, { id: call.id, name: call.name, input: call.input });
  }

  if (hooks["after:tool"]) {
    const fn = hooks["after:tool"];
    fw.afterTool = (
      _ctx: HookContext,
      call: ToolUseBlock,
      result: ToolResultBlock,
      _msgs: readonly Message[],
    ) =>
      fn(
        agentCtx,
        { id: call.id, name: call.name, input: call.input },
        {
          content: String(result.content ?? ""),
          isError: result.is_error,
        },
      );
  }

  if (hooks["before:stop"]) {
    const fn = hooks["before:stop"];
    fw.beforeStop = (_ctx: HookContext, msgs: readonly Message[]) => fn(agentCtx, msgs);
  }

  return definePlugin({ name: "agent-hooks", hooks: fw as Plugin["hooks"] });
}
