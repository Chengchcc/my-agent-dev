import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AIMessageChunk, Message } from "@chengchenccc/message";
import {
  createModelRuntime,
  createOmaRuntime,
  createRuntimeTestContext,
} from "./create-runtime.fixture.js";

const { tmp, FAKE_MODEL, runInput, cleanup } = createRuntimeTestContext();
afterAll(cleanup);
describe("workflow subagents obey the permission gate", () => {
  /** Provider dispatches on the system prompt: the classifier branch sees
   *  the permission-classifier system text, subagents see the subagent
   *  system prompt, the main loop sees neither. This makes the interleaved
   *  model calls (main → subagent → subagent's classifier) deterministic
   *  without the OMA_FAKE_TOOL script queue. */
  function gatingProvider(requests: string[], verdictText: string): Provider {
    return {
      id: "fake",
      name: "Fake",
      getModels: () => [FAKE_MODEL],
      async *stream(_model: Model, messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
        const system = messages.find((m) => m.role === "system")?.text ?? "";
        if (system.includes("permission classifier")) {
          requests.push("classifier");
          yield { delta: { type: "text", text: verdictText } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (system.includes("subagent")) {
          if (!requests.includes("sub-tool")) {
            requests.push("sub-tool");
            yield { delta: { type: "tool_use", id: "t-sub", name: "bash" } };
            yield {
              delta: {
                type: "input_json_delta",
                id: "t-sub",
                partial_json: JSON.stringify({
                  description: "d",
                  command: "echo s > sub-marker.txt",
                }),
              },
            };
            yield { stopReason: "tool_use" };
            return;
          }
          requests.push("sub-done");
          // The denied tool result must have been fed back to the subagent.
          if (messages.some((m) => JSON.stringify(m).includes("blocked by classifier"))) {
            requests.push("sub-saw-classifier-block");
          }
          if (messages.some((m) => JSON.stringify(m).includes("blocked by permissionMode=deny"))) {
            requests.push("sub-saw-deny-block");
          }
          yield { delta: { type: "text", text: "sub finished" } };
          yield { stopReason: "end_turn" };
          return;
        }
        if (!requests.includes("tool")) {
          requests.push("tool");
          yield { delta: { type: "tool_use", id: "t-main", name: "run_workflow" } };
          yield {
            delta: {
              type: "input_json_delta",
              id: "t-main",
              partial_json: JSON.stringify({
                items: [{ prompt: "write a marker file with bash", label: "a" }],
              }),
            },
          };
          yield { stopReason: "tool_use" };
          return;
        }
        requests.push("main");
        yield { delta: { type: "text", text: "done" } };
        yield { usage: { input: 10, output: 3, cacheRead: 1, cacheCreate: 0 } };
        yield { stopReason: "end_turn" };
      },
    };
  }

  const subagentRun = async (opts: {
    runId: string;
    permissionMode: "ask" | "auto" | "deny";
    verdictText: string;
    requests: string[];
  }): Promise<string> => {
    const modelRuntime = createModelRuntime();
    modelRuntime.registerProvider(gatingProvider(opts.requests, opts.verdictText));
    const rt = await createOmaRuntime({
      runId: opts.runId,
      modelId: "fake/echo",
      workspaceRoot: tmp,
      workspaceAccess: "read_write",
      modelRuntime,
      skillRoots: [],
      permissionMode: opts.permissionMode,
    });
    const seg = await rt.run(runInput(opts.runId));
    const out = await seg.outcome;
    await rt.close();
    return JSON.stringify(out.messages);
  };

  test("auto: subagent bash routes through the classifier and is denied", async () => {
    const requests: string[] = [];
    await subagentRun({
      runId: "r-sub-auto",
      permissionMode: "auto",
      verdictText: '{"verdict":"block","reason":"subagent destructive"}',
      requests,
    });
    expect(requests).toContain("classifier");
    // The denial (with reason) was fed back to the SUBAGENT's model.
    expect(requests).toContain("sub-saw-classifier-block");
    expect(existsSync(join(tmp, "sub-marker.txt"))).toBe(false);
  });

  test("deny: subagent bash is blocked outright (pre-existing gap, now closed)", async () => {
    const requests: string[] = [];
    await subagentRun({
      runId: "r-sub-deny",
      permissionMode: "deny",
      verdictText: '{"verdict":"allow"}',
      requests,
    });
    expect(requests).toContain("sub-saw-deny-block");
    expect(requests).not.toContain("classifier");
    expect(existsSync(join(tmp, "sub-marker.txt"))).toBe(false);
  });
});
