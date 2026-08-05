import { describe, expect, test } from "bun:test";
import {
  adaptProductTool,
  buildProductTools,
  type ProductToolCaller,
  type ProductToolCallIdentity,
} from "./product-tool-transport.js";

const IDENTITY = {
  runId: "run-1",
  conversationId: "conv-1",
  agentMemberId: "mem-1",
  branchId: "branch-1",
};

function recordingCaller(
  impl: (p: {
    name: string;
    arguments?: unknown;
    identity: ProductToolCallIdentity;
  }) => Promise<{ content: unknown }>,
): { caller: ProductToolCaller; calls: ProductToolCallIdentity[] } {
  const calls: ProductToolCallIdentity[] = [];
  return {
    calls,
    caller: {
      async callTool(p) {
        calls.push(p.identity);
        return impl(p);
      },
    },
  };
}

describe("product-tool-transport", () => {
  const descriptor = {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object" },
    entrypoint: "stdio:fake",
  };

  test("execute forwards identity + arguments and stringifies content", async () => {
    const { caller, calls } = recordingCaller(async (p) => ({ content: { ok: p.arguments } }));
    const tool = adaptProductTool(
      descriptor,
      { identity: IDENTITY, caller, timeoutMs: 1000 },
      () => "pt-7",
    );
    const result = await tool.execute({ title: "x" });
    expect(result.content).toBe(JSON.stringify({ ok: { title: "x" } }));
    expect(result.isError).toBeUndefined();
    expect(calls[0]).toMatchObject({ runId: "run-1", callId: "pt-7" });
  });

  test("string content is passed through unwrapped", async () => {
    const { caller } = recordingCaller(async () => ({ content: "plain text" }));
    const tool = adaptProductTool(
      descriptor,
      { identity: IDENTITY, caller, timeoutMs: 1000 },
      () => "pt-1",
    );
    expect((await tool.execute({})).content).toBe("plain text");
  });

  test("caller error becomes isError result (never throws to the loop)", async () => {
    const { caller } = recordingCaller(async () => Promise.reject(new Error("unauthorized")));
    const tool = adaptProductTool(
      descriptor,
      { identity: IDENTITY, caller, timeoutMs: 1000 },
      () => "pt-1",
    );
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toBe("unauthorized");
  });

  test("timeout rejects and surfaces isError", async () => {
    const { caller } = recordingCaller(() => new Promise(() => {}));
    const tool = adaptProductTool(
      descriptor,
      { identity: IDENTITY, caller, timeoutMs: 30 },
      () => "pt-1",
    );
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
  });

  test("run AbortSignal aborts the call with isError", async () => {
    const controller = new AbortController();
    const { caller } = recordingCaller(() => new Promise(() => {}));
    const tool = adaptProductTool(
      descriptor,
      { identity: IDENTITY, caller, timeoutMs: 5000 },
      () => "pt-1",
    );
    const pending = tool.execute({}, controller.signal);
    controller.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.content).toContain("aborted");
  });

  test("buildProductTools yields one tool per descriptor with monotonic callIds", async () => {
    const { caller, calls } = recordingCaller(async () => ({ content: "ok" }));
    const tools = buildProductTools([descriptor, { ...descriptor, name: "close_issue" }], {
      identity: IDENTITY,
      caller,
      timeoutMs: 1000,
    });
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe("create_issue");
    await tools[0]?.execute({});
    await tools[1]?.execute({});
    expect(calls.map((c) => c.callId)).toEqual(["pt-1", "pt-2"]);
  });

  test("empty manifest yields no tools", () => {
    const { caller } = recordingCaller(async () => ({ content: "" }));
    expect(buildProductTools([], { identity: IDENTITY, caller, timeoutMs: 1000 })).toHaveLength(0);
  });
});
