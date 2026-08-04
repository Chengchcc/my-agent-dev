import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB per NDJSON line

/** Session IDs are daemon-generated opaque strings, never user paths. */
export const sessionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/, "invalid session id");

export const runIdSchema = z.string().min(1).max(128);
export const commandIdSchema = z.string().min(1).max(128);
export const idempotencyKeySchema = z.string().min(1).max(256);
const historyItemSchema = z.object({
  productEntryId: z.string(),
  message: z.record(z.unknown()),
});

/** Wire BackendInputMessage: durable input id + canonical Message + optional
 *  productEntryId. The sole "actual prompt" - never inferred from history. */
const inputMessageSchema = z.object({
  inputId: z.string().min(1).max(256),
  message: z.record(z.unknown()),
  productEntryId: z.string().optional(),
});

// ─── Daemon → Worker commands ──────────────────────────────────────────

export const openSessionCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("open_session"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  dataDir: z.string(),
  workspaceRoot: z.string(),
  workspaceAccess: z.enum(["read_only", "read_write"]),
  backendKind: z.literal("coding_agent"),
  /** Session-level run identity for runs that carry no metadata of their own
   *  (send/follow-up): the Worker inherits conversation/agentMember from the
   *  session; branchId + productRevision always travel with the command. */
  identity: z.object({
    conversationId: z.string(),
    agentMemberId: z.string(),
  }),
});

export const startRunCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("start_run"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema,
  mode: z.enum(["normal", "follow_up"]),
  history: z.array(historyItemSchema),
  run: z.object({
    runId: runIdSchema,
    model: z.object({ backendKind: z.literal("coding_agent"), modelId: z.string() }),
    systemPrompt: z.string().optional(),
    productTools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
        entrypoint: z.string(),
      }),
    ),
    configRevision: z.number(),
  }),
  input: inputMessageSchema,
  workspace: z.object({ root: z.string(), access: z.enum(["read_only", "read_write"]) }),
  metadata: z.object({
    conversationId: z.string(),
    agentMemberId: z.string(),
    branchId: z.string(),
    productRevision: z.number(),
  }),
});

export const sendCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("send"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema,
  mode: z.enum(["normal", "steer", "follow_up"]),
  history: z.array(historyItemSchema),
  run: z.object({
    runId: runIdSchema,
    model: z.object({ backendKind: z.literal("coding_agent"), modelId: z.string() }),
    systemPrompt: z.string().optional(),
    productTools: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        inputSchema: z.record(z.unknown()),
        entrypoint: z.string(),
      }),
    ),
    configRevision: z.number(),
  }),
  input: inputMessageSchema,
  workspaceRoot: z.string().optional(),
  metadata: z
    .object({
      branchId: z.string(),
      throughEntryId: z.string().optional(),
      productRevision: z.number(),
    })
    .optional(),
});

export const compactCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("compact"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema.optional(),
});

export const stopRunCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("stop_run"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema,
});

export const closeSessionCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("close_session"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  deleteData: z.boolean().default(false),
});

export const shutdownCommand = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("shutdown"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
});

export const workerCommand = z.discriminatedUnion("type", [
  openSessionCommand,
  startRunCommand,
  sendCommand,
  compactCommand,
  stopRunCommand,
  closeSessionCommand,
  shutdownCommand,
]);

export type WorkerCommand = z.infer<typeof workerCommand>;
export type StartRunCommand = z.infer<typeof startRunCommand>;
export type SendCommand = z.infer<typeof sendCommand>;

// ─── Worker → Daemon messages ──────────────────────────────────────────

export const readyMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("ready"),
  backendSessionId: sessionIdSchema,
});

export const commandAcceptedMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("command_accepted"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema.optional(),
});

export const commandResultMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("command_result"),
  commandId: commandIdSchema,
  backendSessionId: sessionIdSchema,
  runId: runIdSchema.optional(),
  result: z.record(z.unknown()),
});

export const eventMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("event"),
  backendSessionId: sessionIdSchema,
  runId: runIdSchema,
  commandId: commandIdSchema.optional(),
  event: z.record(z.unknown()),
});

export const outcomeMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("outcome"),
  backendSessionId: sessionIdSchema,
  runId: runIdSchema,
  outcome: z.union([
    z.object({
      status: z.literal("completed"),
      output: z.record(z.unknown()).optional(),
      usage: z.record(z.unknown()).optional(),
    }),
    z.object({
      status: z.enum(["failed", "aborted", "timeout"]),
      error: z.string().optional(),
      usage: z.record(z.unknown()).optional(),
    }),
  ]),
});

export const commandErrorMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("command_error"),
  commandId: commandIdSchema.optional(),
  backendSessionId: sessionIdSchema.optional(),
  code: z.string(),
  message: z.string(),
});

export const fatalMessage = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal("fatal"),
  backendSessionId: sessionIdSchema.optional(),
  code: z.string(),
  message: z.string(),
});

export const workerMessage = z.discriminatedUnion("type", [
  readyMessage,
  commandAcceptedMessage,
  commandResultMessage,
  eventMessage,
  outcomeMessage,
  commandErrorMessage,
  fatalMessage,
]);

export type WorkerMessage = z.infer<typeof workerMessage>;

// ─── Codec ─────────────────────────────────────────────────────────────

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** Parse one NDJSON line into a WorkerCommand. Rejects unknown versions,
 *  unknown discriminants, and malformed JSON. */
export function parseCommand(line: string): WorkerCommand {
  if (line.length > MAX_LINE_BYTES) {
    throw new ProtocolError("line_too_large", "NDJSON line exceeds size limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("malformed_json", "invalid JSON on stdin");
  }
  const parsed = workerCommand.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError("invalid_command", `command schema rejected: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Parse one NDJSON line into a WorkerMessage. */
export function parseWorkerMessage(line: string): WorkerMessage {
  if (line.length > MAX_LINE_BYTES) {
    throw new ProtocolError("line_too_large", "NDJSON line exceeds size limit");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new ProtocolError("malformed_json", "invalid JSON on stdout");
  }
  const parsed = workerMessage.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError("invalid_message", `message schema rejected: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function serializeMessage(message: WorkerMessage): string {
  return `${JSON.stringify(message)}\n`;
}
