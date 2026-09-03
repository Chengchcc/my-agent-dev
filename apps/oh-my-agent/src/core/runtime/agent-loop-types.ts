import type {
  AskQuestionInput,
  AskQuestionResult,
  BackendInputMessage,
  Usage,
} from "@chengchenccc/agent-contract";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import type { SessionStore } from "../persistence/session-store.js";
import type { AgentLoopListener, OmaLoopEvent } from "./agent-event.js";
import type { ApprovalHandler } from "./approval.js";
import type { CompactionBudget } from "./compaction.js";
import type { TurnUsage } from "./context-estimate.js";
import type { CodingLoopInput } from "./loop-input.js";
import type { Plugin, PluginTool } from "./plugin.js";
import type { PluginRuntime } from "./plugin-runtime.js";
import type { PruneConfig } from "./tool-pruning.js";

/** Thinking-mode effort, aligned with the provider's Anthropic config. */
export interface PendingToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** Summarizes covered messages into a compact context summary. Receives full
 *  Message objects (including tool_use/tool_result blocks) so tool semantics
 *  survive compaction. Injected by the caller (Phase 3 Worker uses
 *  ModelRuntime; tests inject a fake). */
export type ContextSummarizer = (
  messages: readonly Message[],
  signal?: AbortSignal,
) => Promise<string>;

/** Token-aware context budget for proactive compaction. Extends the compaction
 *  budget with a trigger ratio: compaction triggers when estimated tokens
 *  exceed limit * triggerRatio. Phase 3 injects a real model limit and token
 *  estimator; tests inject a simple char/4 proxy. */
export interface ContextBudget extends CompactionBudget {
  /** Compaction triggers when estimated tokens exceed limit * triggerRatio. */
  readonly triggerRatio: number;
}

export interface OmaSessionOptions {
  readonly sessionId: string;
  readonly store: SessionStore;
  readonly plugins: readonly Plugin[];
  readonly maxSteps: number;
  readonly maxForceContinues: number;
  /** The model call for one turn. */
  readonly modelStream: (
    messages: readonly Message[],
    signal?: AbortSignal,
    /** Current tool table (static plugins + per-Run resolved tools). */
    tools?: readonly PluginTool[],
  ) => AsyncIterable<AIMessageChunk>;
  readonly summarize: ContextSummarizer;
  /** HITL approval pipeline (spec): resolves options.request calls from
   *  tools and the ask-mode gate for plugin code tools. Absent = tools see
   *  no `request` and decide themselves. */
  readonly approvalHandler?: ApprovalHandler;
  /** HITL ask pipeline (ask_question tool): resolves options.ask calls. */
  readonly askHandler?: (input: AskQuestionInput) => Promise<AskQuestionResult | null>;
  /** Native-tool permission gate (run-runtime, ADR 0020 permissionMode): runs
   *  AFTER plugin beforeTool hooks; a block result prevents execution. Native
   *  high-risk tools (bash/write/edit/mcp__*) route here so ask/deny apply to
   *  them too — one pipeline for plugin AND native tools. */
  readonly permissionGate?: (
    toolName: string,
    input: unknown,
  ) => Promise<{ block: boolean; reason?: string } | undefined>;
  /** Resolve the model display identity for a run's model ref, used to render
   *  the per-loop Meta. Optional: when omitted (tests), Meta omits the model line. */
  readonly resolveModel?: (modelId: string) => Promise<{ provider: string; id: string }>;
  /** Resolve per-Run additional tools (e.g. the Product Tool manifest from
   *  `input.run.productTools`). Merged into the tool table at each runLoop
   *  start so snapshot changes apply on the next Run without a rebuild. */
  readonly resolveTools?: (input: CodingLoopInput) => Promise<readonly PluginTool[]>;
  /** Runtime capabilities injected into plugin hooks (model stream, store,
   *  workspace, emit). Optional: when omitted, hooks receive a stub with
   *  emit only (backward-compatible with pre-existing plugins). */
  readonly pluginRuntime?: PluginRuntime;
  readonly maxRetries?: number;
  /** Token-aware proactive compaction budget. When estimated context tokens
   *  exceed limit * triggerRatio before a model turn, compact once. Leave
   *  undefined to disable proactive compaction. */
  readonly contextBudget?: ContextBudget;
  /** Tool-output pruning config. When set, old tool
   *  results outside the protect window are truncated to a summary before
   *  each model call — a lighter touch than full compaction. Protected
   *  tools (skills, plans) are never pruned. */
  readonly pruneConfig?: Partial<PruneConfig>;
  /** TTSR-style stream rules (absorbed from oh-my-pi): a regex watched
   * against the assistant text stream. On match the turn is aborted, the
   * partial output discarded, the rule injected as a hidden
   * <system-reminder> user message, and the model retried in the same
   * turn. Tool-argument streams are NOT matched: raw partial JSON escaping
   * makes it unreliable (pi needed per-tool matcherDigest hooks for that). */
  readonly streamRules?: readonly StreamRule[];
  /** Prepend a <system-reminder> to failed tool results instructing the
   * model to fix the cause and retry instead of proceeding as if it
   * succeeded. Default: enabled. */
  readonly toolFailureReminder?: boolean;
  /** Called after each persist of conversational messages (prompt, steer,
   *  follow_up, assistant, tool_result — never meta/product_history). Lets
   *  the caller write the session file in real time (pi's appendMessage):
   *  a killed/failed process still leaves its message trail behind. */
  readonly onPersistMessages?: (messages: readonly Message[]) => void;
}

/** One TTSR-style stream rule. Matching is text-only; each rule fires at
 * most `maxInjections` (default 1) times per Run — pi's repeatMode
 * "once". Patterns must be non-global (loader-side contract). */
export interface StreamRule {
  readonly name: string;
  readonly pattern: RegExp;
  /** Reminder body injected inside <system-reminder> on trigger. */
  readonly message: string;
  /** Max injections per rule per Run. Default 1. */
  readonly maxInjections?: number;
}

/** Terminal result of a loop. `messages` is the canonical message sequence
 *  this Run produced (ADR 0017): assistant(tool_use) / tool(tool_result) /
 *  assistant(text) as separate messages in branch order — never merged into
 *  an assistant message. `usage` is the last usage chunk from the model
 *  stream; `error` is a redacted reason for failed/stopped outcomes. */
export interface OmaLoopResult {
  readonly status: "completed" | "failed" | "stopped";
  readonly messages?: readonly Message[];
  readonly usage?: Usage;
  readonly error?: string;
  /** Auto-generated conversation title (first Run only; backend guards). */
  readonly title?: string;
}

export interface OmaSession {
  readonly sessionId: string;
  readonly status: "idle" | "running" | "completed" | "failed" | "stopped";
  startLoop(input: CodingLoopInput): Promise<OmaLoopResult>;
  startFollowUp(input: CodingLoopInput): Promise<OmaLoopResult>;
  /** Inject a steer input into the active loop. No Meta, no new Loop: the
   *  message is queued and appended at the next safe boundary. */
  steer(input: BackendInputMessage): void;
  stop(): void;
  compact(): Promise<void>;
  onEvent(listener: AgentLoopListener): () => void;
  /** Emit a UI-transient event to all subscribers (for PluginRuntime). */
  emit(event: OmaLoopEvent): void;
}

/** One model turn, accumulated purely from the stream: raw outputs
 *  before any persistence. */
/** One delta in a turn, in the order it arrived — the only source that can
 *  reconstruct why a reasoning strand was interrupted by a text passage and
 *  resumed. Persisting text/thinking as concatenated strings loses this. */
export type TurnBlock = { type: "text"; text: string } | { type: "thinking"; text: string };

export interface ModelTurn {
  readonly text: string;
  readonly thinking: string;
  readonly ordered: readonly TurnBlock[];
  readonly thinkingSignature?: string;
  readonly thinkingRedacted?: boolean;
  readonly toolCalls: readonly PendingToolCall[];
  readonly stopReason?: string;
  /** This call's own usage (legs summed over the call's chunks): anchors
   * context estimation and silent-overflow detection (oh-my-pi). */
  readonly usage?: TurnUsage;
  /** Set when a stream rule matched mid-stream: the turn's partial output
   * is discarded and the rule injected before retrying. */
  readonly streamRuleHit?: StreamRule;
}
