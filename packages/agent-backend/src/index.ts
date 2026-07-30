export type { AgentBackend, AgentBackendCapabilities } from "./backend.js";
export type {
  BackendEvent,
  BackendExtensionEvent,
  CoreBackendEvent,
  Usage,
} from "./event.js";
export type {
  AgentRunSnapshot,
  ProductToolDescriptor,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "./history.js";
export type { BackendModel, BackendModelCatalog, BackendModelRef } from "./model.js";
export type {
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  BackendSessionHandle,
  BackendSessionRun,
  BackendStartInput,
  PendingAction,
  PendingActionResponse,
} from "./run.js";
export { BACKEND_SESSION_HANDLE } from "./run.js";
