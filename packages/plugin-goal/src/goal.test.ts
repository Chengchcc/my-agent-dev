import { describe, expect, test } from "bun:test";
import type { HookContext } from "@my-agent-team/agent";
import type { Message } from "@my-agent-team/message";
import { echoModel } from "@my-agent-team/test-helpers";
import {
  evaluateGoal,
  extractStructuredSummary,
  goalPlugin,
  unresolvedToolErrors,
} from "./goal.js";

// ─── Helpers ───

/** Minimal HookContext for calling beforeStop directly. */
const fakeCtx = { sessionId: "test" } as unknown as HookContext;

// ─── unresolvedToolErrors ───

describe("unresolvedToolErrors", () => {
  test("no tool_results -> undefined", () => {
    const msgs: Message[] = [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ];
    expect(unresolvedToolErrors(msgs)).toBeUndefined();
  });

  test("clean tool_result -> undefined", () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "1", content: "ok" }],
      },
    ] as unknown as Message[];
    expect(unresolvedToolErrors(msgs)).toBeUndefined();
  });

  test("tool_result with is_error -> continue", () => {
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "1", content: "fail", is_error: true }],
      },
    ] as unknown as Message[];
    const v = unresolvedToolErrors(msgs);
    expect(v?.continue).toBe(true);
    if (v?.continue) {
      expect(v.reason).toInclude("error");
    }
  });
});

// ─── goalPlugin shape ───

describe("goalPlugin", () => {
  test("returns correct shape (name=goal, has hooks.beforeStop)", () => {
    const p = goalPlugin();
    expect(p.name).toBe("goal");
    expect(typeof p.hooks.beforeStop).toBe("function");
  });

  test("no error and no goalCondition -> undefined (allow stop)", async () => {
    const p = goalPlugin();
    const msgs: Message[] = [{ role: "user", text: "done" }];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result).toBeUndefined();
  });

  test("extraValidator returns continue -> force continue", async () => {
    const p = goalPlugin({
      extraValidators: [() => ({ continue: true, reason: "validator says keep going" })],
    });
    const msgs: Message[] = [{ role: "user", text: "done" }];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result?.continue).toBe(true);
    if (result?.continue) {
      expect(result.reason).toBe("validator says keep going");
    }
  });

  test("error gate fires before extraValidators", async () => {
    const p = goalPlugin({
      extraValidators: [() => ({ continue: true, reason: "should not reach here" })],
    });
    const msgs: Message[] = [
      {
        role: "user",
        blocks: [{ type: "tool_result", tool_use_id: "1", content: "fail", is_error: true }],
      },
    ] as unknown as Message[];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result?.continue).toBe(true);
    if (result?.continue) {
      expect(result.reason).toInclude("error");
    }
  });

  test("goalCondition without evaluatorModel -> skip LLM, return undefined", async () => {
    const p = goalPlugin({ goalCondition: "tests must pass" });
    const msgs: Message[] = [{ role: "user", text: "done" }];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result).toBeUndefined();
  });
});

// ─── extractStructuredSummary ───

describe("extractStructuredSummary", () => {
  test("parses valid JSON from echoModel", async () => {
    // echoModel turn = count of assistant messages in input.
    // We pass 0 assistant msgs initially, so the prompt becomes the first user msg -> turn 0.
    const model = echoModel({
      turns: [
        {
          type: "text",
          text: JSON.stringify({
            changed_files: ["src/foo.ts"],
            commands_run: ["bun test"],
            test_result: "pass",
            summary: "Fixed foo",
          }),
        },
      ],
    });
    const msgs: Message[] = [{ role: "user", text: "work" }];
    const summary = await extractStructuredSummary(model, msgs);
    expect(summary.changed_files).toEqual(["src/foo.ts"]);
    expect(summary.commands_run).toEqual(["bun test"]);
    expect(summary.test_result).toBe("pass");
    expect(summary.summary).toBe("Fixed foo");
  });

  test("invalid JSON -> returns empty summary", async () => {
    const model = echoModel({
      turns: [{ type: "text", text: "not json at all" }],
    });
    const summary = await extractStructuredSummary(model, []);
    expect(summary).toEqual({
      changed_files: [],
      commands_run: [],
      test_result: "unknown",
      summary: "",
    });
  });
});

// ─── evaluateGoal ───

describe("evaluateGoal", () => {
  test("met=false -> returns { met: false, reason }", async () => {
    const model = echoModel({
      turns: [
        { type: "text", text: JSON.stringify({ met: false, reason: "tests still failing" }) },
      ],
    });
    const result = await evaluateGoal(
      model,
      {
        changed_files: [],
        commands_run: [],
        test_result: "fail",
        summary: "",
      },
      "all tests pass",
    );
    expect(result.met).toBe(false);
    expect(result.reason).toBe("tests still failing");
  });

  test("met=true -> returns { met: true, reason }", async () => {
    const model = echoModel({
      turns: [{ type: "text", text: JSON.stringify({ met: true, reason: "all tests pass" }) }],
    });
    const result = await evaluateGoal(
      model,
      {
        changed_files: [],
        commands_run: [],
        test_result: "pass",
        summary: "",
      },
      "all tests pass",
    );
    expect(result.met).toBe(true);
    expect(result.reason).toBe("all tests pass");
  });

  test("invalid JSON -> returns { met: false, reason: 'evaluation failed' }", async () => {
    const model = echoModel({
      turns: [{ type: "text", text: "garbage" }],
    });
    const result = await evaluateGoal(
      model,
      {
        changed_files: [],
        commands_run: [],
        test_result: "unknown",
        summary: "",
      },
      "goal",
    );
    expect(result.met).toBe(false);
    expect(result.reason).toBe("evaluation failed");
  });
});

// ─── goalPlugin with LLM evaluator integration ───

describe("goalPlugin LLM integration", () => {
  // extractStructuredSummary sees recent msgs + prompt. With an assistant msg
  // in the array, it's turn 1. evaluateGoal sees only its own prompt
  // (0 assistant msgs), so it's turn 0. Script order: [0]=eval, [1]=summary.
  const summaryJson = (override: Record<string, unknown> = {}) =>
    JSON.stringify({
      changed_files: [],
      commands_run: ["bun test"],
      test_result: "pass",
      summary: "done",
      ...override,
    });

  test("evaluator met=false -> beforeStop returns continue", async () => {
    const model = echoModel({
      turns: [
        { type: "text", text: JSON.stringify({ met: false, reason: "tests not passing" }) },
        { type: "text", text: summaryJson({ test_result: "fail" }) },
      ],
    });
    const p = goalPlugin({ goalCondition: "tests pass", evaluatorModel: model });
    const msgs: Message[] = [
      { role: "user", text: "do work" },
      { role: "assistant", text: "done" },
    ];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result?.continue).toBe(true);
    if (result?.continue) {
      expect(result.reason).toBe("tests not passing");
    }
  });

  test("evaluator met=true -> beforeStop returns undefined", async () => {
    const model = echoModel({
      turns: [
        { type: "text", text: JSON.stringify({ met: true, reason: "goal achieved" }) },
        { type: "text", text: summaryJson() },
      ],
    });
    const p = goalPlugin({ goalCondition: "tests pass", evaluatorModel: model });
    const msgs: Message[] = [
      { role: "user", text: "do work" },
      { role: "assistant", text: "done" },
    ];
    const result = await p.hooks.beforeStop!(fakeCtx, msgs);
    expect(result).toBeUndefined();
  });
});
