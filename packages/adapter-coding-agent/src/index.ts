export {
  CodingAgentBackend,
  type CodingAgentBackendOptions,
  CodingAgentProcessError,
  type CodingAgentProcessErrorCode,
} from "./backend.js";
export { mapRunEvent, mapRunOutcome, type TransportRunEvent } from "./event-mapper.js";
export { CodingAgentModelCatalog } from "./model-catalog.js";
export {
  type CodingAgentCommandConfig,
  ProcessSpawnError,
  type SpawnedCodingAgentProcess,
  spawnCodingAgentProcess,
} from "./process.js";
export type {
  AbortCommand,
  CodingAgentCommand,
  CodingAgentOutput,
  EventOutput,
  ExecuteCommand,
  ExecuteRunInput,
  ModelCatalogResponse,
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
