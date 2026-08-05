import { z } from "zod";

/** Frozen HTTP/SSE wire contract shared by the Coding Agent daemon and the
 *  adapter transport client. Lives in the CONTRACT package (agent-backend) so
 *  neither side imports the other's implementation: the daemon consumes it
 *  directly, the adapter re-exports it for its client. */

export const runIdSchema = z.string().min(1).max(128);
export const branchIdSchema = z.string().min(1).max(256);
export const productEntryIdSchema = z.string().min(1).max(256);
export const conversationIdSchema = z.string().min(1).max(256);
export const agentMemberIdSchema = z.string().min(1).max(256);

const messageSchema = z.record(z.unknown());

const productToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  entrypoint: z.string(),
});

const runSnapshotSchema = z.object({
  runId: runIdSchema,
  model: z.object({ backendKind: z.literal("coding_agent"), modelId: z.string() }),
  systemPrompt: z.string().optional(),
  productTools: z.array(productToolSchema),
  configRevision: z.number(),
});

const projectedHistorySchema = z.array(
  z.object({ productEntryId: productEntryIdSchema, message: messageSchema }),
);

/** Wire form of BackendInputMessage: the durable input id + canonical Message +
 *  optional productEntryId. The actual driving input - never inferred. */
const inputMessageSchema = z.object({
  inputId: z.string().min(1).max(256),
  message: messageSchema,
  productEntryId: productEntryIdSchema.optional(),
});

// ─── Requests ─────────────────────────────────────────────────────────

export const createRunRequestSchema = z.object({
  history: projectedHistorySchema,
  input: inputMessageSchema,
  run: runSnapshotSchema,
  workspace: z.object({ root: z.string(), access: z.enum(["read_only", "read_write"]) }),
  metadata: z.object({
    conversationId: conversationIdSchema,
    agentMemberId: agentMemberIdSchema,
    branchId: branchIdSchema,
  }),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const steerRunRequestSchema = z.object({
  input: inputMessageSchema,
});
export type SteerRunRequest = z.infer<typeof steerRunRequestSchema>;

export const stopRunRequestSchema = z.object({});
export type StopRunRequest = z.infer<typeof stopRunRequestSchema>;

// ─── Responses ────────────────────────────────────────────────────────

export const createRunResponseSchema = z.object({
  runId: runIdSchema,
  accepted: z.boolean(),
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

export const steerRunResponseSchema = z.object({ accepted: z.boolean() });
export const stopRunResponseSchema = z.object({ stopped: z.boolean() });

// ─── Events / outcome ─────────────────────────────────────────────────

export const runEventEnvelopeSchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.unknown()),
});
export type RunEventEnvelope = z.infer<typeof runEventEnvelopeSchema>;

export const runOutcomeResponseSchema = z.object({
  runId: runIdSchema,
  status: z.enum(["completed", "failed", "aborted", "timeout"]),
  output: messageSchema.optional(),
  error: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
      costUsd: z.number().optional(),
    })
    .optional(),
});
export type RunOutcomeResponse = z.infer<typeof runOutcomeResponseSchema>;

export const modelCatalogResponseSchema = z.object({
  backendKind: z.literal("coding_agent"),
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      reasoning: z.boolean(),
      inputModalities: z.array(z.string()),
      contextWindow: z.number(),
      maxOutputTokens: z.number(),
      available: z.boolean(),
    }),
  ),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;

// ─── Transport errors ─────────────────────────────────────────────────

export const transportErrorSchema = z.object({
  code: z.enum([
    "invalid_request",
    "unauthorized",
    "not_found",
    "conflict",
    "busy",
    "replay_window_exceeded",
    "internal",
  ]),
  message: z.string(),
});
export type TransportErrorCode = z.infer<typeof transportErrorSchema>["code"];
