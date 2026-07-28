import type { AIMessageChunk, ContentBlock, ToolUseBlock } from "@my-agent-team/core";
import { collectStream, finalizeToolUseInputs, mergeChunkIntoBlocks } from "@my-agent-team/core";
import type {
  Message,
  MessageRevision,
  MessageState,
  MessageToolState,
} from "@my-agent-team/message";
import { assistantMessageId } from "@my-agent-team/message";
import type { AgentEvent } from "./agent-event.js";
import type { AgentRuntime, FollowUpQueue, SteeringQueue } from "./agent-options.js";
import { executeOne, runOneCollect } from "./execute-one.js";
import { wrapToolResult } from "./plugin-dispatcher.js";

// ─── Pure helpers ──────────────────────────────────────────────

export function buildAssistantRevision(
  spanId: string,
  ordinal: number,
  state: MessageState,
  blocks: ContentBlock[],
  tools: MessageToolState[],
): MessageRevision {
  return {
    messageId: assistantMessageId(spanId, ordinal),
    role: "assistant",
    state,
    blocks: blocks.slice(),
    tools: tools.length > 0 ? tools.map((t) => ({ ...t })) : undefined,
    spanId,
    visibility: "conversation",
    updatedAt: Date.now(),
  };
}

/** Insert a meta user message before the first real user message.
 *  System messages stay before meta; the first user message comes after. */
function insertMetaMessage(messages: readonly Message[], metaText: string): Message[] {
  const firstUser = messages.findIndex((m) => m.role === "user");
  const meta: Message = { role: "user", text: metaText };
  if (firstUser < 0) return [...messages, meta];
  return [...messages.slice(0, firstUser), meta, ...messages.slice(firstUser)];
}

/** Extract tool states from tool_use blocks (all "running" initially). */
export function extractToolStates(blocks: ContentBlock[]): MessageToolState[] {
  return blocks
    .filter((b): b is ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, state: "running" as const }));
}

// ─── spanLoop (per-span step iteration) ─────────────────────

export async function* spanLoop(
  rt: AgentRuntime,
  opts: {
    signal?: AbortSignal;
    maxSteps: number;
    stream?: boolean;
    maxForceContinues?: number;
    steering?: SteeringQueue;
    followUp?: FollowUpQueue;
  },
): AsyncGenerator<AgentEvent> {
  // Refresh thread cache from session at span start so fork/回溯/compaction
  // are reflected. No-op when the thread has no session.
  await rt.thread.refreshMessages?.();
  let forceContinues = 0;
  const maxForce = opts.maxForceContinues ?? 3;
  // M17.4 (Patch C v3): a run materializes as a single growing assistant
  // message (M17.2 full-run visibility). Ordinal is reserved for a future
  // multi-message-per-run semantic; today it is always 0. Blocks/tools
  // accumulate across steps and are NOT reset per turn — resetting them
  // orphaned every non-final turn in a permanently-open (streaming) state.
  const assistantOrdinal = 0;
  let doneNormally = false;
  while (true) {
    for (let step = 0; step < opts.maxSteps; step++) {
      if (opts.signal?.aborted) {
        // M17.2 fix: mark remaining running tools as error, emit with accumulated blocks
        markRunningToolsAsError(rt);
        yield {
          type: "message",
          payload: {
            ...buildAssistantRevision(
              rt.spanId,
              assistantOrdinal,
              "error",
              rt.assistantBlocks,
              rt.toolStates,
            ),
            error: { message: "Run aborted" },
          },
        };
        await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
          type: "run_end",
          reason: "aborted",
          ts: Date.now(),
        });
        return;
      }

      // Drain steering messages injected externally (e.g. from a human operator
      // or another agent). They appear as user messages at the next step boundary.
      const pending = opts.steering?.drain() ?? [];
      if (pending.length > 0) {
        for (const m of pending) rt.thread.push(m);
        await rt.save(rt.thread.messages);
      }

      // P2.2 fix: beforeModel first so shape sees the final payload.
      // Injected content (memory, skill index, system prompt) is marked as
      // preserved so the shaper doesn't drop it.
      const injected = await rt.plugins.fireBeforeModel(rt.thread.messages);
      // Insert meta user message (runtime context: date, workspace, skills)
      // after plugins have injected system prompts, before contextManager.shape.
      const metaText = rt.metaContext?.({
        sessionId: rt.thread.id,
        threadMessages: injected,
        context: rt.context,
      });
      const withMeta = metaText ? insertMetaMessage(injected, metaText) : injected;
      // Mark all messages (including meta) as preserved - shaper must not drop them.
      const preserve = { ranges: [{ start: 0, end: withMeta.length }] };
      const finalMsgs = await rt.contextManager.shape(
        {
          sessionId: rt.thread.id,
          signal: opts.signal,
          logger: rt.logger,
          model: rt.model,
          preserve,
          session: rt.session,
        },
        withMeta,
      );

      await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
        type: "model_start",
        messageCount: finalMsgs.length,
        ts: Date.now(),
      });

      const llmStart = Date.now();
      let ttftMs: number | undefined;
      let stopReason: string | undefined;

      const modelStream = rt.model.stream(finalMsgs, { signal: opts.signal, tools: rt.tools });
      let blocks: ContentBlock[];
      let usage: AIMessageChunk["usage"];

      if (opts.stream) {
        blocks = [];
        const partialJson = new Map<string, string>();
        for await (const chunk of modelStream) {
          if (chunk.delta?.type === "text" && ttftMs === undefined) {
            ttftMs = Date.now() - llmStart;
          }
          mergeChunkIntoBlocks(blocks, partialJson, chunk);
          if (chunk.usage !== undefined) usage = chunk.usage;
          if (chunk.stopReason) stopReason = chunk.stopReason;
          if (chunk.done) break;
          // Emit message_update for every chunk — frontend renders incrementally
          yield {
            type: "message_update" as const,
            payload: buildAssistantRevision(
              rt.spanId,
              assistantOrdinal,
              "streaming",
              // Combine previous turn blocks with current streaming blocks
              // so the frontend sees the full accumulated text so far.
              [...rt.assistantBlocks, ...blocks],
              rt.toolStates,
            ),
          };
        }
        finalizeToolUseInputs(blocks, partialJson);
      } else {
        const collected = await collectStream(modelStream);
        blocks = collected.blocks;
        usage = collected.usage;
        if (collected.stopReason) stopReason = collected.stopReason;
      }

      const latencyMs = Date.now() - llmStart;
      await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
        type: "model_end",
        blocks: blocks.slice(),
        usage,
        model: rt.model.id ?? "unknown",
        step,
        latencyMs,
        ttftMs,
        stopReason,
        ts: Date.now(),
      });

      yield {
        type: "llm_call",
        payload: {
          step,
          model: rt.model.id ?? "unknown",
          usage: {
            input: usage?.input ?? 0,
            output: usage?.output ?? 0,
            cacheCreate: usage?.cacheCreate,
            cacheRead: usage?.cacheRead,
          },
          latencyMs: Date.now() - llmStart,
          ttftMs,
          stopReason,
        },
      };

      if (blocks.length === 0) {
        throw new Error(
          `Model returned zero content blocks (model=${rt.model.id ?? "unknown"}, messages=${finalMsgs.length}). Check API key, base URL, and network connectivity.`,
        );
      }

      // Push assistant message to thread (internal, for LLM context)
      const assistantMsg: Message = { role: "assistant", blocks: blocks.slice() };
      rt.thread.push(assistantMsg);
      await rt.plugins.fireAfterModel(rt.thread.messages);

      // M17.2 fix: Accumulate blocks for full-run visibility
      rt.assistantBlocks.push(...blocks);

      // Extract and merge tool states
      const newTools = extractToolStates(blocks);
      for (const nt of newTools) {
        const existing = rt.toolStates.findIndex((t) => t.id === nt.id);
        if (existing >= 0) rt.toolStates[existing] = nt;
        else rt.toolStates.push(nt);
      }

      // Emit message revision with accumulated blocks
      yield {
        type: "message",
        payload: buildAssistantRevision(
          rt.spanId,
          assistantOrdinal,
          "streaming",
          rt.assistantBlocks,
          rt.toolStates,
        ),
      };

      const toolUses = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (maxForce > 0 && forceContinues < maxForce) {
          const verdict = await rt.plugins.fireBeforeStop(rt.thread.messages);
          for (const ev of rt.pendingEvents.splice(0)) yield ev;
          if (verdict?.continue) {
            forceContinues++;
            rt.thread.push({ role: "user", text: verdict.reason });
            await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
              type: "force_continue",
              reason: verdict.reason,
              attempt: forceContinues,
              ts: Date.now(),
            });
            await rt.save(rt.thread.messages);
            continue;
          }
        }
        await rt.save(rt.thread.messages);
        yield {
          type: "message",
          payload: buildAssistantRevision(
            rt.spanId,
            assistantOrdinal,
            "done",
            rt.assistantBlocks,
            rt.toolStates,
          ),
        };
        await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
          type: "run_end",
          reason: "complete",
          ts: Date.now(),
        });
        doneNormally = true;
        break;
      }

      // Group tool_use blocks into batches: consecutive concurrent tools
      // form a parallel batch; serial tools each get their own single-item batch.
      const batches: ToolUseBlock[][] = [];
      for (let i = 0; i < toolUses.length; ) {
        const call = toolUses[i]!;
        const mode = rt.toolMap.get(call.name)?.executionMode ?? "serial";
        if (mode === "concurrent") {
          const batch: ToolUseBlock[] = [call];
          let j = i + 1;
          while (j < toolUses.length) {
            const next = toolUses[j]!;
            const nextMode = rt.toolMap.get(next.name)?.executionMode ?? "serial";
            if (nextMode !== "concurrent") break;
            batch.push(next);
            j++;
          }
          batches.push(batch);
          i = j;
        } else {
          batches.push([call]);
          i++;
        }
      }

      let interrupted: boolean;
      for (const batch of batches) {
        if (batch.length === 1) {
          // Single serial tool — use existing generator path
          interrupted = yield* executeOne(rt, batch[0]!, opts, step);
          if (interrupted) {
            // executeOne does not push tool_result on interrupt — push it here
            // so the interrupting tool gets a placeholder (matches old serial-loop cleanup)
            rt.thread.push({
              role: "user",
              blocks: [wrapToolResult(batch[0]!, { content: "Interrupted", isError: true })],
            });
            updateToolState(rt, batch[0]!.id, "error", true);
          }
        } else {
          // Concurrent batch — run tools in parallel
          const results = await Promise.all(
            batch.map((call) =>
              runOneCollect(rt, call, opts, step).catch((err) => {
                // One tool crashed — return error result so other results are preserved
                return {
                  resultBlock: wrapToolResult(call, { content: String(err), isError: true }),
                  events: [
                    {
                      type: "tool_call" as const,
                      payload: { step, id: call.id, name: call.name, latencyMs: 0, isError: true },
                    },
                  ],
                  interrupted: false,
                };
              }),
            ),
          );

          // Write tool_results in original tool_use order (not completion order)
          for (let rIdx = 0; rIdx < batch.length; rIdx++) {
            rt.thread.push({ role: "user", blocks: [results[rIdx]!.resultBlock] });
          }
          await rt.save(rt.thread.messages);

          // Yield events in original tool_use order
          for (let rIdx = 0; rIdx < batch.length; rIdx++) {
            for (const ev of results[rIdx]!.events) yield ev;
          }

          interrupted = results.some((r) => r.interrupted);
        }

        if (interrupted) {
          // Mark remaining batches' tools as error (aborted/interrupted)
          const batchIdx = batches.indexOf(batch);
          for (let bi = batchIdx + 1; bi < batches.length; bi++) {
            for (const call of batches[bi]!) {
              rt.thread.push({
                role: "user",
                blocks: [wrapToolResult(call, { content: "Interrupted", isError: true })],
              });
              updateToolState(rt, call.id, "error", true);
            }
          }
          yield {
            type: "message",
            payload: buildAssistantRevision(
              rt.spanId,
              assistantOrdinal,
              "waiting",
              rt.assistantBlocks,
              rt.toolStates,
            ),
          };
          await rt.save(rt.thread.messages);
          return;
        }
      }

      // After all tools in this step completed, emit updated revision
      yield {
        type: "message",
        payload: buildAssistantRevision(
          rt.spanId,
          assistantOrdinal,
          "streaming",
          rt.assistantBlocks,
          rt.toolStates,
        ),
      };
    }

    // After inner step loop exhausts, check for follow-up messages.
    // Follow-ups are injected externally (e.g. queued tasks, continuation
    // prompts) and restart the inner loop as new "user" input.
    const followUps = opts.followUp?.drain() ?? [];
    if (followUps.length === 0) break;
    for (const m of followUps) rt.thread.push(m);
    await rt.save(rt.thread.messages);
    forceContinues = 0;
    doneNormally = false;
  }

  if (!doneNormally) {
    // M17.2 fix: maxSteps reached — mark remaining running tools as error
    markRunningToolsAsError(rt);
    yield {
      type: "message",
      payload: {
        ...buildAssistantRevision(
          rt.spanId,
          assistantOrdinal,
          "error",
          rt.assistantBlocks,
          rt.toolStates,
        ),
        error: { message: "Max steps reached" },
      },
    };
    await rt.eventLog?.appendEvent(rt.thread.id, rt.spanId, {
      type: "run_end",
      reason: "maxSteps",
      ts: Date.now(),
    });
  }
}

/** Mark any still-running tools as error (used at abort/maxSteps boundaries). */
function markRunningToolsAsError(rt: AgentRuntime): void {
  for (const ts of rt.toolStates) {
    if (ts.state === "running") {
      ts.state = "error";
      ts.isError = true;
    }
  }
}

/** Helper to update a single tool's state. */
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
