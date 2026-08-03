// Phase 2: Coding Agent Runtime
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
export { createSqliteSessionStore } from "./persistence/sqlite-session-store.js";

// Runtime
export type { AgentLoopListener, CodingAgentLoopEvent } from "./runtime/agent-event.js";
export type {
  CodingAgentSession,
  CodingAgentSessionOptions,
  ContextSummarizer,
} from "./runtime/agent-loop.js";
export { createCodingAgentSession } from "./runtime/agent-loop.js";
export type { CompactionResult } from "./runtime/compaction.js";
// Compaction + retry
export { compactSession } from "./runtime/compaction.js";
export type { LoopInputDeps, LoopInputResult } from "./runtime/loop-input.js";
export { buildLoopInput } from "./runtime/loop-input.js";
// Plugin
export type { MetaSectionProvider, Plugin, PluginHooks, PluginTool } from "./runtime/plugin.js";
export { collectTools, renderMeta, validatePlugins } from "./runtime/plugin.js";
// Prompt
export type { LoopMetaInput } from "./runtime/prompt.js";
export { renderLoopMeta } from "./runtime/prompt.js";
export type { RetryOptions } from "./runtime/retry.js";
export { retryStream } from "./runtime/retry.js";
export type { TodoItem, TodoState } from "./runtime/todo.js";
// Todo
export { readTodo, updateTodo, writeTodo } from "./runtime/todo.js";
