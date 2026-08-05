import { type TransportErrorCode, transportErrorSchema } from "@my-agent-team/agent-backend";

/** The wire schemas are the neutral transport contract and live in
 *  `@my-agent-team/agent-backend` - re-exported here so the adapter's client
 *  keeps one import surface and neither side imports the other's
 *  implementation. This file holds only transport CLIENT concerns: the
 *  structured error type. */

export type {
  CreateRunRequest,
  CreateRunResponse,
  ModelCatalogResponse,
  RunEventEnvelope,
  RunOutcomeResponse,
  SteerRunRequest,
  StopRunRequest,
  TransportErrorCode,
} from "@my-agent-team/agent-backend";
export {
  agentMemberIdSchema,
  branchIdSchema,
  conversationIdSchema,
  createRunRequestSchema,
  createRunResponseSchema,
  modelCatalogResponseSchema,
  productEntryIdSchema,
  runEventEnvelopeSchema,
  runIdSchema,
  runOutcomeResponseSchema,
  steerRunRequestSchema,
  steerRunResponseSchema,
  stopRunRequestSchema,
  stopRunResponseSchema,
  transportErrorSchema,
} from "@my-agent-team/agent-backend";

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

export function parseTransportError(raw: unknown): TransportError {
  const parsed = transportErrorSchema.safeParse(raw);
  return new TransportError(
    parsed.success ? parsed.data.code : "internal",
    parsed.success ? parsed.data.message : JSON.stringify(raw),
  );
}
