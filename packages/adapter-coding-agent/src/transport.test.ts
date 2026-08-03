import { describe, expect, test } from "bun:test";
import {
  sendRunRequestSchema,
  startSessionRequestSchema,
  transportErrorSchema,
} from "./transport.js";

function validStart() {
  return {
    idempotencyKey: "ikey-1",
    history: [{ productEntryId: "pe-1", message: { role: "user", text: "hi" } }],
    run: {
      runId: "run-1",
      model: { backendKind: "coding_agent", modelId: "anthropic/claude-sonnet" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: "/tmp/ws", access: "read_write" },
    metadata: {
      conversationId: "conv-1",
      agentMemberId: "mem-1",
      branchId: "branch-1",
      productRevision: 1,
    },
  };
}

describe("transport DTOs", () => {
  test("startSessionRequest round-trips", () => {
    const parsed = startSessionRequestSchema.parse(validStart());
    expect(parsed.metadata.branchId).toBe("branch-1");
    expect(parsed.history[0]?.productEntryId).toBe("pe-1");
  });

  test("start rejects missing snapshot", () => {
    const bad = validStart();
    delete (bad as { run?: unknown }).run;
    expect(() => startSessionRequestSchema.parse(bad)).toThrow();
  });

  test("start rejects missing productEntryId", () => {
    const bad = validStart();
    bad.history = [{ message: { role: "user", text: "x" } }] as never;
    expect(() => startSessionRequestSchema.parse(bad)).toThrow();
  });

  test("send rejects unknown mode", () => {
    const body = {
      idempotencyKey: "k",
      commandId: "c",
      messages: [],
      run: validStart().run,
      mode: "teleport",
      promptText: "p",
      metadata: { branchId: "b", productRevision: 1 },
    };
    expect(() => sendRunRequestSchema.parse(body)).toThrow();
  });

  test("send accepts steer and follow_up", () => {
    for (const mode of ["steer", "follow_up"] as const) {
      const body = {
        idempotencyKey: "k",
        commandId: "c",
        messages: [],
        run: validStart().run,
        mode,
        promptText: "p",
        metadata: { branchId: "b", productRevision: 1 },
      };
      expect(sendRunRequestSchema.parse(body).mode).toBe(mode);
    }
  });

  test("malformed identities rejected", () => {
    const bad = validStart();
    bad.metadata.branchId = "";
    expect(() => startSessionRequestSchema.parse(bad)).toThrow();
  });

  test("transport error schema parses", () => {
    const parsed = transportErrorSchema.parse({ code: "conflict", message: "key reused" });
    expect(parsed.code).toBe("conflict");
  });
});
