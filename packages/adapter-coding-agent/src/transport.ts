import { z } from "zod";

/** Frozen HTTP/SSE wire contract shared by the Coding Agent daemon and the
 *  adapter transport client. One source of truth; neither side imports the
 *  other's implementation. */

export const backendSessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "invalid session id");
export const runIdSchema = z.string().min(1).max(128);
export const commandIdSchema = z.string().min(1).max(128);
export const idempotencyKeySchema = z.string().min(1).max(256);
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

export const startSessionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  history: projectedHistorySchema,
  input: inputMessageSchema,
  run: runSnapshotSchema,
  workspace: z.object({ root: z.string(), access: z.enum(["read_only", "read_write"]) }),
  env: z.record(z.string()).optional(),
  metadata: z.object({
    conversationId: conversationIdSchema,
    agentMemberId: agentMemberIdSchema,
    branchId: branchIdSchema,
    productRevision: z.number(),
  }),
});
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;

export const sendRunRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  commandId: commandIdSchema,
  history: projectedHistorySchema,
  input: inputMessageSchema,
  run: runSnapshotSchema,
  mode: z.enum(["normal", "steer", "follow_up"]),
  workspaceRoot: z.string().optional(),
  metadata: z.object({
    branchId: branchIdSchema,
    throughEntryId: z.string().optional(),
    productRevision: z.number(),
  }),
});
export type SendRunRequest = z.infer<typeof sendRunRequestSchema>;

export const resumeSessionRequestSchema = startSessionRequestSchema;
export type ResumeSessionRequest = StartSessionRequest;

export const compactSessionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  commandId: commandIdSchema,
  runId: runIdSchema.optional(),
});
export type CompactSessionRequest = z.infer<typeof compactSessionRequestSchema>;

export const stopSessionRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  commandId: commandIdSchema,
  runId: runIdSchema.optional(),
});
export type StopSessionRequest = z.infer<typeof stopSessionRequestSchema>;

// ─── Responses ────────────────────────────────────────────────────────

export const sessionResponseSchema = z.object({
  backendSessionId: backendSessionIdSchema,
  runId: runIdSchema,
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sendRunResponseSchema = z.object({
  backendSessionId: backendSessionIdSchema,
  runId: runIdSchema,
  commandId: commandIdSchema,
  accepted: z.boolean(),
});
export type SendRunResponse = z.infer<typeof sendRunResponseSchema>;

export const stopSessionResponseSchema = z.object({ stopped: z.boolean() });
export const closeSessionResponseSchema = z.object({ closed: z.boolean() });
export const compactSessionResponseSchema = z.object({ compacted: z.boolean() });

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
type TransportErrorCode = z.infer<typeof transportErrorSchema>["code"];

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}
