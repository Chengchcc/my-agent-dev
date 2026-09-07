import type { Usage } from "@chengchenccc/agent-contract";
import { debugLog } from "@chengchenccc/agent-contract";
import type { Message } from "@chengchenccc/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { OmaLoopEvent } from "./agent-event.js";
import type {
  ModelTurn,
  OmaSessionOptions,
  PendingToolCall,
  StreamRule,
  TurnBlock,
} from "./agent-loop-types.js";
import { matchStreamRule, safeParseJson } from "./agent-loop-utils.js";
import type { TurnUsage } from "./context-estimate.js";
import type { Plugin, PluginTool } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import { retryStream } from "./retry.js";

export interface LoopRuntimeState {
  runUsage: Usage | undefined;
  debugTurn: number;
  debugModelId: string;
  debugRunId: string;
  streamRuleInjections: Map<string, number>;
}

export interface LoopToolMapRef {
  current: Map<string, PluginTool>;
}

export interface LoopCallContext {
  opts: OmaSessionOptions;
  emit(event: OmaLoopEvent): Promise<void>;
  toolMapRef: LoopToolMapRef;
  controller: AbortController | null;
  rt: PluginRuntime;
  state: LoopRuntimeState;
}

/** Coalesce consecutive same-kind stream deltas into one TurnBlock.
 *  `ordered` models contiguous thinking/text SEGMENTS (the trace shape),
 *  not provider chunk boundaries — Anthropic extended thinking streams a
 *  body one character per text_delta, and storing each chunk as its own
 *  block persisted "让" / "\n\n" / "我" as fake paragraphs. */
function appendOrderedDelta(ordered: TurnBlock[], next: TurnBlock): void {
  const last = ordered.at(-1);
  if (last?.type === next.type) {
    ordered[ordered.length - 1] = { type: next.type, text: last.text + next.text };
    return;
  }
  ordered.push(next);
}
export async function streamModelTurn(
  ctx: LoopCallContext,
  messages: readonly Message[],
): Promise<ModelTurn> {
  const { opts, emit, toolMapRef, controller, state } = ctx;
  let text = "";
  let thinking = "";
  const ordered: TurnBlock[] = [];
  let thinkingSignature: string | undefined;
  let thinkingRedacted = false;
  const toolCallBuilders = new Map<string, { id: string; name: string; jsonParts: string[] }>();
  state.debugTurn++;
  debugLog(
    "oma",
    `model_start runId=${state.debugRunId} turn=${state.debugTurn} model=${state.debugModelId}`,
  );

  await emit({ type: "message_start" });
  const stream = retryStream(
    (signal) => opts.modelStream(messages, signal, [...toolMapRef.current.values()]),
    {
      maxAttempts: opts.maxRetries ?? 3,
      baseDelayMs: 1000,
      onRetryStart: (attempt) => emit({ type: "retry_start", attempt }),
      onRetryEnd: () => emit({ type: "retry_end" }),
    },
    controller?.signal,
  );

  let stopReason: string | undefined;
  let streamRuleHit: StreamRule | undefined;
  let turnUsage: TurnUsage | undefined;
  let runUsage = state.runUsage;
  try {
    for await (const chunk of stream) {
      if (controller?.signal.aborted) break;
      if (chunk.stopReason) stopReason = chunk.stopReason;
      if (chunk.usage) {
        // Accumulate across all model calls in the Run (not last-wins)...
        runUsage = {
          inputTokens: (runUsage?.inputTokens ?? 0) + (chunk.usage.input ?? 0),
          outputTokens: (runUsage?.outputTokens ?? 0) + (chunk.usage.output ?? 0),
          cacheReadTokens: (runUsage?.cacheReadTokens ?? 0) + (chunk.usage.cacheRead ?? 0),
          cacheWriteTokens: (runUsage?.cacheWriteTokens ?? 0) + (chunk.usage.cacheCreate ?? 0),
        };
        // ...and per turn: this call's own total anchors context
        // estimation and silent-overflow detection (oh-my-pi).
        turnUsage = {
          inputTokens: (turnUsage?.inputTokens ?? 0) + (chunk.usage.input ?? 0),
          outputTokens: (turnUsage?.outputTokens ?? 0) + (chunk.usage.output ?? 0),
          cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + (chunk.usage.cacheRead ?? 0),
          cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + (chunk.usage.cacheCreate ?? 0),
        };
      }
      if (chunk.delta?.type === "text") {
        text += chunk.delta.text;
        appendOrderedDelta(ordered, { type: "text", text: chunk.delta.text });
        await emit({ type: "message_update", text: chunk.delta.text });
        const hit = opts.streamRules
          ? matchStreamRule(opts.streamRules, text, state.streamRuleInjections)
          : undefined;
        if (hit) {
          streamRuleHit = hit;
          break;
        }
      }
      if (chunk.delta?.type === "reasoning") {
        thinking += chunk.delta.text;
        appendOrderedDelta(ordered, { type: "thinking", text: chunk.delta.text });
        await emit({ type: "thinking_update", text: chunk.delta.text });
      }
      if (chunk.delta?.type === "reasoning_signature") {
        thinkingSignature = chunk.delta.signature;
        thinkingRedacted = chunk.delta.redacted === true;
      }
      if (chunk.delta?.type === "tool_use") {
        const id = chunk.delta.id;
        if (!toolCallBuilders.has(id)) {
          toolCallBuilders.set(id, { id, name: chunk.delta.name, jsonParts: [] });
        }
      }
      if (chunk.delta?.type === "input_json_delta") {
        const builder = toolCallBuilders.get(chunk.delta.id);
        if (builder) builder.jsonParts.push(chunk.delta.partial_json);
      }
    }
  } finally {
    // message_end always pairs with message_start, even on failure/abort.
    await emit({ type: "message_end" });
  }
  state.runUsage = runUsage;
  debugLog(
    "oma",
    `model_end runId=${state.debugRunId} turn=${state.debugTurn} stopReason=${stopReason ?? "none"}`,
  );

  return {
    text,
    thinking,
    ordered,
    ...(thinkingSignature ? { thinkingSignature } : {}),
    ...(thinkingRedacted ? { thinkingRedacted: true } : {}),
    toolCalls: Array.from(toolCallBuilders.values()).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.jsonParts.length > 0 ? safeParseJson(b.jsonParts.join("")) : {},
    })),
    stopReason,
    ...(turnUsage ? { usage: turnUsage } : {}),
    ...(streamRuleHit ? { streamRuleHit } : {}),
  };
}

export async function executeTools(
  ctx: LoopCallContext,
  calls: readonly PendingToolCall[],
): Promise<Array<{ id: string; result: unknown; isError: boolean; terminate: boolean }>> {
  const { opts, emit, toolMapRef, controller, rt, state } = ctx;
  const toolMap = toolMapRef.current;
  const results: Array<{ id: string; result: unknown; isError: boolean; terminate: boolean }> = [];

  async function runOne(
    call: PendingToolCall,
  ): Promise<{ id: string; result: unknown; isError: boolean; terminate: boolean }> {
    const tool = toolMap.get(call.name);
    debugLog("oma", `tool_start runId=${state.debugRunId} name=${call.name} callId=${call.id}`);
    await emit({
      type: "tool_execution_start",
      toolName: call.name,
      callId: call.id,
      input: call.input,
      ...(tool?.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
    });
    let result: unknown;
    let isError = false;
    let terminate = false;
    let input = call.input;
    if (tool) {
      // transformToolArgs: rewrite call args before execution.
      for (const p of opts.plugins) {
        if (p.hooks?.transformToolArgs) {
          try {
            const transformed = p.hooks.transformToolArgs(call.name, input, rt);
            if (transformed && typeof transformed === "object") {
              input = transformed as Record<string, unknown>;
            }
          } catch {
            /* plugin transform errors never block execution */
          }
        }
      }
      // beforeTool: observe or block. A block result emits an error tool
      // result instead of executing.
      let blocked = false;
      let blockReason = `Blocked by plugin`;
      for (const p of opts.plugins) {
        if (p.hooks?.beforeTool) {
          try {
            const ret = p.hooks.beforeTool(call.name, input, rt);
            if (ret?.block) {
              blocked = true;
              if (ret.reason) blockReason = ret.reason;
              break;
            }
          } catch {
            /* plugin errors never block execution */
          }
        }
      }
      // Native-tool permission gate (ADR 0020): runs AFTER plugin
      // beforeTool hooks so a plugin block always wins; ask/deny here
      // apply to native high-risk tools too.
      if (!blocked && opts.permissionGate) {
        try {
          const verdict = await opts.permissionGate(call.name, input);
          if (verdict?.block) {
            blocked = true;
            if (verdict.reason) blockReason = verdict.reason;
          }
        } catch (err) {
          // M8: fail CLOSED. The gate is the ask/deny/auto authority — a
          // thrown verdict (classifier OOM, non-Error, refactor drift)
          // must block the tool, never silently allow it.
          blocked = true;
          blockReason =
            "permission gate error — fail closed: " +
            (err instanceof Error ? err.message : String(err));
        }
      }
      if (blocked) {
        result = { error: blockReason };
        isError = true;
      } else {
        try {
          result = await tool.execute(input, controller?.signal, {
            callId: call.id,
            onOutput: (text) => {
              void emit({
                type: "tool_output",
                toolName: call.name,
                callId: call.id,
                text,
              });
            },
            ...(opts.approvalHandler
              ? {
                  request: (req: { reason?: string }) =>
                    opts.approvalHandler!({
                      callId: call.id,
                      toolName: call.name,
                      input,
                      source: "tool",
                      ...(req.reason ? { reason: req.reason } : {}),
                    }),
                }
              : {}),
            ...(opts.askHandler ? { ask: opts.askHandler } : {}),
          });
          if (result && typeof result === "object") {
            if ("isError" in result) {
              isError = Boolean((result as { isError?: unknown }).isError);
            }
            if ("terminate" in result) {
              terminate = Boolean((result as { terminate?: unknown }).terminate);
            }
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          isError = true;
        }
      }
    } else {
      result = { error: `Unknown tool: ${call.name}` };
      isError = true;
    }
    debugLog(
      "oma",
      `tool_end runId=${state.debugRunId} name=${call.name} callId=${call.id} error=${isError}`,
    );
    await emit({
      type: "tool_execution_end",
      toolName: call.name,
      callId: call.id,
      result: (result ?? {}) as Readonly<Record<string, unknown>>,
    });
    // afterTool: observe (emit event) or patch (override result fields).
    for (const p of opts.plugins) {
      try {
        const ret = p.hooks?.afterTool?.(call.name, result, rt);
        if (ret) {
          // OmaLoopEvent (has `type`) → emit; patch object →
          // override result fields field-by-field.
          if ("type" in ret) {
            await emit(ret);
          } else {
            if (ret.content !== undefined) result = ret.content;
            if (ret.isError !== undefined) isError = ret.isError;
            if (ret.terminate !== undefined) terminate = ret.terminate;
          }
        }
      } catch {
        /* plugin errors never affect the loop */
      }
    }
    return { id: call.id, result, isError, terminate };
  }

  let i = 0;
  while (i < calls.length) {
    if (controller?.signal.aborted) break;
    const call = calls[i]!;
    const isConcurrent = toolMap.get(call.name)?.executionMode === "concurrent";
    if (!isConcurrent) {
      // Serial tool: run alone (barrier before and after).
      if (controller?.signal.aborted) break;
      const r = await runOne(call);
      if (controller?.signal.aborted) break;
      results.push(r);
      i++;
      continue;
    }
    // Collect a maximal run of consecutive concurrent tools.
    const batch: PendingToolCall[] = [call];
    let j = i + 1;
    while (j < calls.length) {
      const next = calls[j]!;
      if (toolMap.get(next.name)?.executionMode !== "concurrent") break;
      batch.push(next);
      j++;
    }
    // Run the whole batch in parallel.
    const batchResults = await Promise.all(batch.map((c) => runOne(c)));
    if (controller?.signal.aborted) break;
    results.push(...batchResults);
    i = j;
  }
  return results;
}

export async function readBranchMessages(
  store: SessionStore,
  sessionId: string,
): Promise<Message[]> {
  const entries = await store.readBranch(sessionId);

  // Find latest CompactionEntry
  let compactionSummary: string | null = null;
  let coveredIds: Set<string> | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      const comp = entries[i] as { summary: string; coversEntryIds: readonly string[] };
      compactionSummary = comp.summary;
      coveredIds = new Set(comp.coversEntryIds);
      break;
    }
  }

  return entries
    .filter((e) => {
      if (e.type !== "message") return false;
      if (coveredIds?.has(e.entryId)) return false;
      return true;
    })
    .map((e) => {
      const msg = (e as { message: Message }).message;
      // Prepend compaction summary as a system note if entries were compacted
      return msg;
    })
    .flatMap((msg, _i, _arr) => {
      // Insert summary as first user message if compaction applied
      if (_i === 0 && compactionSummary && coveredIds && coveredIds.size > 0) {
        return [
          { role: "user" as const, text: `[Context summary: ${compactionSummary}]` } as Message,
          msg,
        ];
      }
      return [msg];
    });
}

// re-exported type convenience for the caller
export type { Plugin };
