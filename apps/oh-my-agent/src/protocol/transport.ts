import { backendKindSchema } from "@chengchenccc/agent-contract";
import { z } from "zod";

/** Frozen stdio JSONL wire contract shared by the Oma RPC mode and
 *  the adapter's child-process transport. Lives in the CONTRACT package
 *  (agent-backend) so neither side imports the other's implementation: the
 *  Oma consumes it directly, the adapter re-exports it.
 *
 *  Framing: one JSON document per line, LF (`\n`) only. Commands travel on
 *  stdin, outputs on stdout. stderr is for logs only. */

export const runIdSchema = z.string().min(1).max(128);
export const branchIdSchema = z.string().min(1).max(256);
export const productEntryIdSchema = z.string().min(1).max(256);
export const conversationIdSchema = z.string().min(1).max(256);
export const agentIdSchema = z.string().min(1).max(256);

const messageSchema = z.record(z.unknown());

const runSnapshotSchema = z.object({
  runId: runIdSchema,
  model: z.object({
    backendKind: backendKindSchema,
    modelId: z.string(),
    reasoningEffort: z.enum(["none", "low", "high", "max"]).optional(),
  }),
  systemPrompt: z.string().optional(),
  /** Skill pack roots (absolute dirs scanned for SKILL.md), frozen at Run
   *  creation. Empty/absent = no skills. */
  skillRoots: z.array(z.string()).optional(),
  cliSessionRef: z.string().optional(),
  /** Frozen permission_mode (ADR 0020 decision 7); absent = default. */
  permissionMode: z.enum(["ask", "auto", "deny"]).optional(),
  /** Frozen workflow budget (tokens); absent = no gate. */
  workflowBudgetTokens: z.number().int().nonnegative().optional(),
  configRevision: z.number(),
});

/** Wire form of BackendInputMessage: the durable input id + canonical Message +
 *  optional productEntryId. The actual driving input - never inferred. */
const inputMessageSchema = z.object({
  inputId: z.string().min(1).max(256),
  message: messageSchema,
  productEntryId: productEntryIdSchema.optional(),
});

// ─── Execute payload (the full Run input crossing the boundary) ───────

export const executeRunInputSchema = z.object({
  input: inputMessageSchema,

  run: runSnapshotSchema,
  workspace: z.object({ root: z.string(), access: z.enum(["read_only", "read_write"]) }),
  metadata: z.object({
    conversationId: conversationIdSchema,
    agentId: agentIdSchema,
    branchId: branchIdSchema,
  }),
  /** Oma workflow-mode: run the script directly instead of a loop. */
  workflow: z
    .object({
      script: z.string().min(1).max(32768),
      args: z.unknown().optional(),
    })
    .optional(),
});
export type ExecuteRunInput = z.infer<typeof executeRunInputSchema>;

export const steerRunInputSchema = inputMessageSchema;
export type SteerRunInput = z.infer<typeof steerRunInputSchema>;

// ─── Commands (stdin, one JSON object per line) ──────────────────────

export const executeCommandSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("execute"),
  input: executeRunInputSchema,
});
export type ExecuteCommand = z.infer<typeof executeCommandSchema>;

export const steerCommandSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("steer"),
  runId: runIdSchema,
  input: steerRunInputSchema,
});
export type SteerCommand = z.infer<typeof steerCommandSchema>;

export const abortCommandSchema = z.object({
  id: z.string().min(1).max(64),
  type: z.literal("abort"),
  runId: runIdSchema,
});
export type AbortCommand = z.infer<typeof abortCommandSchema>;

export const codingAgentCommandSchema = z.discriminatedUnion("type", [
  executeCommandSchema,
  steerCommandSchema,
  abortCommandSchema,
]);
export type OmaCommand = z.infer<typeof codingAgentCommandSchema>;

// ─── Outputs (stdout, one JSON object per line) ──────────────────────

export const responseOutputSchema = z.object({
  // Empty id is reserved for failure responses to unparseable commands
  // (no command id exists to echo back).
  id: z.string().max(64),
  type: z.literal("response"),
  command: z.enum(["execute", "steer", "abort"]),
  success: z.boolean(),
  data: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});
export type ResponseOutput = z.infer<typeof responseOutputSchema>;

/** Runtime event envelope: `data` is the raw Oma loop event object. */
export const runEventEnvelopeSchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.string(),
  data: z.record(z.unknown()),
});
export type RunEventEnvelope = z.infer<typeof runEventEnvelopeSchema>;

export const eventOutputSchema = z.object({
  type: z.literal("event"),
  runId: runIdSchema,
  event: runEventEnvelopeSchema,
});
export type EventOutput = z.infer<typeof eventOutputSchema>;

export const outcomeOutputSchema = z.object({
  type: z.literal("outcome"),
  runId: runIdSchema,
  outcome: z.object({
    status: z.enum(["completed", "failed", "aborted", "timeout"]),
    messages: z.array(messageSchema).optional(),
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
    title: z.string().optional(),
    cliSessionRef: z.string().optional(),
    workflow: z
      .object({
        ok: z.boolean(),
        value: z.unknown(),
        usage: z
          .object({
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            cacheReadTokens: z.number().optional(),
            cacheWriteTokens: z.number().optional(),
            costUsd: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});
export type OutcomeOutput = z.infer<typeof outcomeOutputSchema>;

export const codingAgentOutputSchema = z.discriminatedUnion("type", [
  responseOutputSchema,
  eventOutputSchema,
  outcomeOutputSchema,
]);
export type OmaOutput = z.infer<typeof codingAgentOutputSchema>;

// ─── Model catalog (CLI --list-models --json) ────────────────────────

export const modelCatalogResponseSchema = z.object({
  backendKind: backendKindSchema,
  models: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      reasoning: z.boolean(),
      inputModalities: z.array(z.string()),
      contextWindow: z.number(),
      maxOutputTokens: z.number(),
      available: z.boolean(),
      cost: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
      }),
    }),
  ),
});
export type ModelCatalogResponse = z.infer<typeof modelCatalogResponseSchema>;
