export { CodingAgentBackend, type CodingAgentSessionRef } from "./backend.js";
export { CodingAgentClient, type CodingAgentClientOptions } from "./client.js";
export { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
export { CodingAgentModelCatalog } from "./model-catalog.js";
export type {
  CompactSessionRequest,
  ModelCatalogResponse,
  ResumeSessionRequest,
  RunEventEnvelope,
  RunOutcomeResponse,
  SendRunRequest,
  StartSessionRequest,
  StopSessionRequest,
} from "./transport.js";
export {
  compactSessionRequestSchema,
  modelCatalogResponseSchema,
  resumeSessionRequestSchema,
  runEventEnvelopeSchema,
  runOutcomeResponseSchema,
  sendRunRequestSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  TransportError,
  transportErrorSchema,
} from "./transport.js";
