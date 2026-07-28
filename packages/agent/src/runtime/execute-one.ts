import type { ToolResultBlock, ToolUseBlock } from "@my-agent-team/core";
import { InterruptSignal } from "../persistence/interrupt-store.js";
import type { AgentEvent } from "./agent-event.js";
import type { AgentRuntime } from "./agent-options.js";
import { wrapToolResult } from "./plugin-dispatcher.js";

// ─── executeOne (extracted from createAgentInternal) ────────────

export async function* executeOne(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): AsyncGenerator<AgentEvent, boolean> {
  await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
    type: "tool_start",
    call,
    ts: Date.now(),
  });

  yield {
    type: "tool_execution_start" as const,
    payload: { id: call.id, name: call.name, step },
  };

  const toolStart = Date.now();
  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    rt.thread.push({ role: "user", blocks: [r] });
    await rt.save(rt.thread.messages);
    yield {
      type: "tool_call",
      payload: {
        step,
        id: call.id,
        name: call.name,
        latencyMs: Date.now() - toolStart,
        isError: r.is_error === true,
      },
    };
    // Update tool state in the running revision
    updateToolState(rt, call.id, r.is_error === true ? "error" : "done", r.is_error === true);
    return false;
  }

  let resultBlock: ToolResultBlock;
  try {
    const input = decision?.input ?? call.input;
    const tool = rt.toolMap.get(call.name);
    if (!tool) {
      resultBlock = wrapToolResult(call, {
        content: `Tool not found: ${call.name}`,
        isError: true,
      });
    } else {
      resultBlock = wrapToolResult(call, await tool.execute(input, opts.signal));
    }
  } catch (err) {
    if (err instanceof InterruptSignal) {
      await rt.save(rt.thread.messages);
      if (!rt.interruptStore) {
        throw new Error(
          "Tool requested interrupt but interruptStore is not configured. " +
            "Provide an interruptStore implementing saveInterrupt/consumeInterrupt.",
          { cause: err },
        );
      }
      await rt.interruptStore.saveInterrupt(rt.thread.id, {
        pendingTool: { call, reason: err.reason },
        ts: Date.now(),
        meta: err.meta,
      });
      await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
        type: "interrupt",
        pendingTool: call,
        reason: err.reason,
        ts: Date.now(),
      });
      yield {
        type: "tool_call",
        payload: {
          step,
          id: call.id,
          name: call.name,
          latencyMs: Date.now() - toolStart,
          isError: true,
        },
      };
      // Update tool state to error for interrupt
      updateToolState(rt, call.id, "error", true);
      yield {
        type: "interrupted",
        payload: { pendingTool: call, reason: err.reason, meta: err.meta },
      };
      return true;
    }
    resultBlock = wrapToolResult(call, {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }

  rt.thread.push({ role: "user", blocks: [resultBlock] });
  await rt.plugins.fireAfterTool(call, resultBlock, rt.thread.messages);
  for (const ev of rt.pendingEvents.splice(0)) yield ev;
  await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
    type: "tool_end",
    result: resultBlock,
    durationMs: Date.now() - toolStart,
    step,
    name: call.name,
    isError: resultBlock.is_error === true,
    ts: Date.now(),
  });
  yield {
    type: "tool_call",
    payload: {
      step,
      id: call.id,
      name: call.name,
      latencyMs: Date.now() - toolStart,
      isError: resultBlock.is_error === true,
      args: call.input,
      result: resultBlock,
    },
  };
  // Update tool state in the running revision
  updateToolState(
    rt,
    call.id,
    resultBlock.is_error === true ? "error" : "done",
    resultBlock.is_error === true,
  );
  await rt.save(rt.thread.messages);
  return false;
}

/** M17.2 fix: shared helper to eliminate repeated tool-state update pattern. */
function updateToolState(
  rt: AgentRuntime,
  toolId: string,
  state: "done" | "error",
  isError: boolean,
): void {
  const ts = rt.toolStates.find((t) => t.id === toolId);
  if (ts) {
    ts.state = state;
    ts.isError = isError;
  }
}

/** Non-generator variant of executeOne for use inside Promise.all in batch execution.
 *  Returns results directly instead of yielding — caller handles ordering and yielding. */
export interface RunOneResult {
  resultBlock: ToolResultBlock;
  events: AgentEvent[];
  interrupted: boolean;
}

export async function runOneCollect(
  rt: AgentRuntime,
  call: ToolUseBlock,
  opts: { signal?: AbortSignal },
  step: number,
): Promise<RunOneResult> {
  const events: AgentEvent[] = [];
  const toolStart = Date.now();

  await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
    type: "tool_start",
    call,
    ts: Date.now(),
  });

  events.push({
    type: "tool_execution_start" as const,
    payload: { id: call.id, name: call.name, step },
  });

  const decision = await rt.plugins.fireBeforeTool(call, rt.thread.messages);

  if (decision?.skip) {
    const r = wrapToolResult(call, {
      content: decision.result ?? "Tool skipped",
      isError: decision.isError ?? (decision.result ? true : undefined),
    });
    // NOTE: do NOT push to rt.thread.messages — caller handles ordering.
    events.push({
      type: "tool_call",
      payload: {
        step,
        id: call.id,
        name: call.name,
        latencyMs: Date.now() - toolStart,
        isError: r.is_error === true,
      },
    });
    updateToolState(rt, call.id, r.is_error === true ? "error" : "done", r.is_error === true);
    return { resultBlock: r, events, interrupted: false };
  }

  let resultBlock: ToolResultBlock;
  try {
    const input = decision?.input ?? call.input;
    const tool = rt.toolMap.get(call.name);
    if (!tool) {
      resultBlock = wrapToolResult(call, {
        content: `Tool not found: ${call.name}`,
        isError: true,
      });
    } else {
      resultBlock = wrapToolResult(call, await tool.execute(input, opts.signal));
    }
  } catch (err) {
    if (err instanceof InterruptSignal) {
      await rt.save(rt.thread.messages);
      if (!rt.interruptStore) {
        throw new Error(
          "Tool requested interrupt but interruptStore is not configured. " +
            "Provide an interruptStore implementing saveInterrupt/consumeInterrupt.",
          { cause: err },
        );
      }
      await rt.interruptStore.saveInterrupt(rt.thread.id, {
        pendingTool: { call, reason: err.reason },
        ts: Date.now(),
        meta: err.meta,
      });
      await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
        type: "interrupt",
        pendingTool: call,
        reason: err.reason,
        ts: Date.now(),
      });
      events.push({
        type: "tool_call",
        payload: {
          step,
          id: call.id,
          name: call.name,
          latencyMs: Date.now() - toolStart,
          isError: true,
        },
      });
      updateToolState(rt, call.id, "error", true);
      events.push({
        type: "interrupted",
        payload: { pendingTool: call, reason: err.reason, meta: err.meta },
      });
      return {
        resultBlock: wrapToolResult(call, { content: "Interrupted", isError: true }),
        events,
        interrupted: true,
      };
    }
    resultBlock = wrapToolResult(call, {
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    });
  }

  // NOTE: do NOT push to rt.thread.messages here — the caller (spanLoop batch
  // handler) writes results in tool_use order to guarantee ordering regardless
  // of which tool completes first in a parallel batch.
  await rt.plugins.fireAfterTool(call, resultBlock, rt.thread.messages);
  for (const ev of rt.pendingEvents.splice(0)) events.push(ev);
  await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
    type: "tool_end",
    result: resultBlock,
    durationMs: Date.now() - toolStart,
    step,
    name: call.name,
    isError: resultBlock.is_error === true,
    ts: Date.now(),
  });
  events.push({
    type: "tool_call",
    payload: {
      step,
      id: call.id,
      name: call.name,
      latencyMs: Date.now() - toolStart,
      isError: resultBlock.is_error === true,
      args: call.input,
      result: resultBlock,
    },
  });
  updateToolState(
    rt,
    call.id,
    resultBlock.is_error === true ? "error" : "done",
    resultBlock.is_error === true,
  );
  // save is deferred to the caller (spanLoop batch handler) so it can
  // save once after all ordered results are pushed.
  return { resultBlock, events, interrupted: false };
}
