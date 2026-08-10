/** The stdio JSONL wire schemas are the neutral transport contract and live
 *  in `@my-agent-team/agent-backend` - re-exported here so the adapter keeps
 *  one import surface and neither side imports the other's implementation.
 *  Nothing is copied: this file only re-exports the contract. */

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
} from "@my-agent-team/agent-backend";
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
} from "@my-agent-team/agent-backend";
