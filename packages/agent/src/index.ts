// Phase 2: Oma Runtime
//
// Persistence

export { createInMemorySessionStore } from "./persistence/in-memory-session-store.js";
export type {
  AppendBatchInput,
  AppendBatchResult,
  SessionStore,
} from "./persistence/session-store.js";
export type {
  CodingSessionEntry,
  CodingSessionMetadata,
  CodingSessionOperation,
  CodingSessionSnapshot,
  CompactionEntry,
  MessageEntry,
  TodoStateEntry,
} from "./persistence/session-tree.js";

// Runtime
export type { AgentLoopListener, OmaLoopEvent } from "./runtime/agent-event.js";
export type {
  ContextBudget,
  ContextSummarizer,
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
} from "./runtime/agent-loop.js";
export { createOmaSession } from "./runtime/agent-loop.js";
export type { CompactionResult } from "./runtime/compaction.js";
// Compaction + retry
export { compactSession } from "./runtime/compaction.js";
export type { CodingLoopInput, LoopInputDeps, LoopInputResult } from "./runtime/loop-input.js";
export { buildLoopInput } from "./runtime/loop-input.js";
// Plugin
export type { MetaSectionProvider, Plugin, PluginHooks, PluginTool } from "./runtime/plugin.js";
export { collectTools, renderMeta, validatePlugins } from "./runtime/plugin.js";
export type { PluginRuntime } from "./runtime/plugin-runtime.js";
// Prompt
export type { LoopMetaInput } from "./runtime/prompt.js";
export { renderLoopMeta } from "./runtime/prompt.js";
export type { RetryOptions } from "./runtime/retry.js";
export { retryStream } from "./runtime/retry.js";
export type { TodoItem, TodoState } from "./runtime/todo.js";
// Todo
export { readTodo, updateTodo, writeTodo } from "./runtime/todo.js";
