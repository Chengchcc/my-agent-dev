import { describe, expect, test } from "bun:test";
import {
  MAX_LINE_BYTES,
  PROTOCOL_VERSION,
  ProtocolError,
  parseCommand,
  parseWorkerMessage,
  serializeMessage,
  type WorkerCommand,
  type WorkerMessage,
} from "./worker-protocol.js";

function openCommand(overrides: Record<string, unknown> = {}): WorkerCommand {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "open_session",
    commandId: "cmd-1",
    backendSessionId: "sess-1",
    dataDir: "/tmp/data",
    workspaceRoot: "/tmp/ws",
    workspaceAccess: "read_write" as const,
    backendKind: "coding_agent",
    createIfMissing: true,
    productTools: [],
    identity: { runId: "r", conversationId: "c", agentMemberId: "m", branchId: "b" },
    ...overrides,
  } as unknown as WorkerCommand;
}

describe("worker protocol", () => {
  test("open_session round-trips", () => {
    const line = JSON.stringify(openCommand());
    const parsed = parseCommand(line);
    expect(parsed.type).toBe("open_session");
    expect(parsed.backendSessionId).toBe("sess-1");
  });

  test("rejects unknown protocol version", () => {
    expect(() => parseCommand(JSON.stringify(openCommand({ protocolVersion: 99 })))).toThrow(
      ProtocolError,
    );
  });

  test("rejects unknown command discriminant", () => {
    expect(() => parseCommand(JSON.stringify({ type: "teleport", commandId: "x" }))).toThrow(
      ProtocolError,
    );
  });

  test("rejects malformed JSON", () => {
    expect(() => parseCommand("{not json")).toThrow(ProtocolError);
  });

  test("rejects oversized lines", () => {
    const big = JSON.stringify(openCommand()) + "x".repeat(MAX_LINE_BYTES);
    expect(() => parseCommand(big)).toThrow(ProtocolError);
  });

  test("rejects malformed session identity", () => {
    expect(() =>
      parseCommand(JSON.stringify(openCommand({ backendSessionId: "../etc/passwd" }))),
    ).toThrow(ProtocolError);
  });

  test("rejects unknown send mode", () => {
    const cmd = {
      protocolVersion: PROTOCOL_VERSION,
      type: "send",
      commandId: "c",
      backendSessionId: "s",
      runId: "r",
      mode: "teleport",
      messages: [],
      run: {
        runId: "r",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      promptText: "p",
    };
    expect(() => parseCommand(JSON.stringify(cmd))).toThrow(ProtocolError);
  });

  test("start_run preserves productEntryId without renaming", () => {
    const cmd = {
      protocolVersion: PROTOCOL_VERSION,
      type: "start_run",
      commandId: "c",
      backendSessionId: "s",
      runId: "r",
      mode: "normal",
      history: [{ productEntryId: "pe-42", message: { role: "user", text: "hi" } }],
      run: {
        runId: "r",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      input: { inputId: "in-1", message: { role: "user", text: "prompt" } },
      workspace: { root: "/tmp/ws", access: "read_write" },
      metadata: { conversationId: "c", agentMemberId: "m", branchId: "b", productRevision: 1 },
    };
    const parsed = parseCommand(JSON.stringify(cmd));
    expect(parsed.type).toBe("start_run");
    const start = parsed as Extract<WorkerCommand, { type: "start_run" }>;
    expect(start.history[0]?.productEntryId).toBe("pe-42");
  });

  test("missing history is rejected", () => {
    const cmd = {
      protocolVersion: PROTOCOL_VERSION,
      type: "start_run",
      commandId: "c",
      backendSessionId: "s",
      runId: "r",
      mode: "normal",
      run: {
        runId: "r",
        model: { backendKind: "coding_agent", modelId: "m" },
        productTools: [],
        configRevision: 1,
      },
      metaText: "meta",
      promptText: "prompt",
      systemPrompt: "sp",
      workspaceRoot: "/tmp/ws",
    };
    expect(() => parseCommand(JSON.stringify(cmd))).toThrow(ProtocolError);
  });

  test("worker message round-trip with identity", () => {
    const msg: WorkerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "event",
      backendSessionId: "s",
      runId: "r",
      event: { type: "message_update", text: "hi" },
    };
    const parsed = parseWorkerMessage(serializeMessage(msg).trim());
    expect(parsed.type).toBe("event");
    if (parsed.type === "event") {
      expect(parsed.backendSessionId).toBe("s");
      expect(parsed.runId).toBe("r");
    }
  });

  test("serialize emits exactly one JSON line", () => {
    const msg: WorkerMessage = {
      protocolVersion: PROTOCOL_VERSION,
      type: "ready",
      backendSessionId: "s",
    };
    const serialized = serializeMessage(msg);
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  test("rejects malformed worker message", () => {
    expect(() => parseWorkerMessage(JSON.stringify({ type: "boom" }))).toThrow(ProtocolError);
  });
});
