import { describe, expect, test } from "bun:test";
import {
  createRunRequestSchema,
  steerRunRequestSchema,
  transportErrorSchema,
} from "./transport.js";

function validRun() {
  return {
    history: [{ productEntryId: "pe-1", message: { role: "user", text: "hi" } }],
    input: { inputId: "in-1", message: { role: "user", text: "do it" } },
    run: {
      runId: "run-1",
      model: { backendKind: "coding_agent", modelId: "fake/echo" },
      productTools: [],
      configRevision: 1,
    },
    workspace: { root: "/tmp/ws", access: "read_write" },
    metadata: {
      conversationId: "conv-1",
      agentMemberId: "mem-1",
      branchId: "branch-1",
    },
  };
}

describe("transport DTOs", () => {
  test("createRunRequest round-trips", () => {
    const parsed = createRunRequestSchema.parse(validRun());
    expect(parsed.metadata.branchId).toBe("branch-1");
    expect(parsed.history[0]?.productEntryId).toBe("pe-1");
    expect(parsed.run.runId).toBe("run-1");
  });

  test("create rejects missing snapshot", () => {
    const bad = validRun();
    delete (bad as { run?: unknown }).run;
    expect(() => createRunRequestSchema.parse(bad)).toThrow();
  });

  test("create rejects missing productEntryId", () => {
    const bad = validRun();
    bad.history = [{ message: { role: "user", text: "x" } }] as never;
    expect(() => createRunRequestSchema.parse(bad)).toThrow();
  });

  test("create rejects session-era fields", () => {
    // Legacy session fields (idempotencyKey and the old session id) are not
    // part of the Run protocol: unknown keys are stripped by the wire schema,
    // never accepted.
    const parsed = createRunRequestSchema.parse({ ...validRun(), idempotencyKey: "k" });
    expect((parsed as { idempotencyKey?: unknown }).idempotencyKey).toBeUndefined();
  });

  test("create rejects missing workspace (a Run execution fact)", () => {
    const bad = validRun();
    delete (bad as { workspace?: unknown }).workspace;
    expect(() => createRunRequestSchema.parse(bad)).toThrow();
  });

  test("steer request requires the input message", () => {
    expect(() => steerRunRequestSchema.parse({})).toThrow();
    expect(
      steerRunRequestSchema.parse({
        input: { inputId: "in-s", message: { role: "user", text: "x" } },
      }).input.inputId,
    ).toBe("in-s");
  });

  test("malformed identities rejected", () => {
    const bad = validRun();
    bad.metadata.branchId = "";
    expect(() => createRunRequestSchema.parse(bad)).toThrow();
  });

  test("transport error schema parses", () => {
    const parsed = transportErrorSchema.parse({ code: "conflict", message: "key reused" });
    expect(parsed.code).toBe("conflict");
  });
});
