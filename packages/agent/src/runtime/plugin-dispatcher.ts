import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { PluginRunner } from "./agent-options.js";
import type { Logger } from "./logger.js";
import type { HookContext, Plugin, StopDecision } from "./plugin.js";

export function wrapToolResult(
  call: ToolUseBlock,
  result: { content: string; isError?: boolean },
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    content: result.content,
    ...(result.isError !== undefined ? { is_error: result.isError } : {}),
  };
}

export function createPluginRunner(
  plugins: readonly Plugin[],
  ctx: HookContext,
  logger: Logger,
): PluginRunner {
  async function eachPlugin(hookName: string, fn: (p: Plugin) => Promise<void>): Promise<void> {
    for (const p of plugins) {
      try {
        await fn(p);
      } catch (err) {
        logger.warn(`Plugin ${p.name} ${hookName} error`, err);
      }
    }
  }

  return {
    async fireBeforeModel(msgs: Message[]): Promise<Message[]> {
      let result = msgs;
      await eachPlugin("beforeModel", async (p) => {
        if (p.hooks.beforeModel) {
          const out = await p.hooks.beforeModel(ctx, result);
          if (Array.isArray(out)) result = out;
        }
      });
      return result;
    },
    async fireAfterModel(msgs: readonly Message[]): Promise<void> {
      await eachPlugin("afterModel", async (p) => {
        await p.hooks.afterModel?.(ctx, msgs);
      });
    },
    async fireBeforeTool(
      call: ToolUseBlock,
      msgs: readonly Message[],
    ): Promise<
      { skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined
    > {
      for (const p of plugins) {
        if (p.hooks.beforeTool) {
          try {
            const r = await p.hooks.beforeTool(ctx, call, msgs);
            if (r) return r;
          } catch (err) {
            logger.warn(`Plugin ${p.name} beforeTool error`, err);
          }
        }
      }
      return undefined;
    },
    async fireAfterTool(
      call: ToolUseBlock,
      result: ToolResultBlock,
      msgs: readonly Message[],
    ): Promise<void> {
      await eachPlugin("afterTool", async (p) => {
        await p.hooks.afterTool?.(ctx, call, result, msgs);
      });
    },
    async fireBeforeRun(msgs: readonly Message[]): Promise<readonly Message[]> {
      let result = msgs;
      await eachPlugin("beforeRun", async (p) => {
        if (p.hooks.beforeRun) {
          const out = await p.hooks.beforeRun(ctx, result);
          if (Array.isArray(out)) result = out;
        }
      });
      return result;
    },
    async fireBeforeStop(msgs: readonly Message[]): Promise<StopDecision | undefined> {
      for (const p of plugins) {
        if (p.hooks.beforeStop) {
          const r = await p.hooks.beforeStop(ctx, msgs);
          if (r) return r;
        }
      }
      return undefined;
    },
  };
}
