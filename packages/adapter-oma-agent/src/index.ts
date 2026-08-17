export {
  OmaBackend,
  type OmaBackendOptions,
  OmaProcessError,
  type OmaProcessErrorCode,
} from "./backend.js";
export { mapRunEvent, mapRunOutcome, type TransportRunEvent } from "./event-mapper.js";
export { OmaModelCatalog } from "./model-catalog.js";
export {
  type OmaCommandConfig,
  ProcessSpawnError,
  type SpawnedOmaProcess,
  spawnOmaProcess,
} from "./process.js";
export type {
  AbortCommand,
  EventOutput,
  ExecuteCommand,
  ExecuteRunInput,
  ModelCatalogResponse,
  OmaCommand,
  OmaOutput,
  OutcomeOutput,
  ResponseOutput,
  RunEventEnvelope,
  SteerCommand,
  SteerRunInput,
} from "./protocol.js";
export {
  abortCommandSchema,
  codingAgentCommandSchema,
  codingAgentOutputSchema,
  eventOutputSchema,
  executeCommandSchema,
  modelCatalogResponseSchema,
  outcomeOutputSchema,
  responseOutputSchema,
  runEventEnvelopeSchema,
  runIdSchema,
  steerCommandSchema,
  steerRunInputSchema,
} from "./protocol.js";
export { collectSecrets, createStderrTail, redactText, type StderrTail } from "./stderr-tail.js";
