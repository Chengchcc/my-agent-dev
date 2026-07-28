import {
  definePlugin,
  type HookContext,
  type Plugin,
  type StopDecision,
} from "@my-agent-team/agent";
import type { ChatModel } from "@my-agent-team/core";
import { collectStream } from "@my-agent-team/core";
import { extractText, type Message } from "@my-agent-team/message";

// ─── Types ───

export type StopValidator = (
  messages: readonly Message[],
) => StopDecision | undefined | Promise<StopDecision | undefined>;

/** Structured summary of agent work, produced by a small model. */
export interface WorkSummary {
  changed_files: string[];
  commands_run: string[];
  test_result: "pass" | "fail" | "unknown";
  summary: string;
}

export interface GoalPluginOptions {
  goalCondition?: string | (() => string | null);
  evaluatorModel?: ChatModel;
  extraValidators?: StopValidator[];
  /** Called after each LLM evaluation with the result (for state tracking). */
  onEvaluation?: (result: { summary: WorkSummary; evaluation: GoalEvaluation }) => void;
}

// ─── Deterministic validators ───

/**
 * Find the last user message with tool_result blocks.
 * If any tool_result has is_error=true without a subsequent attempt to retry,
 * signal force-continue so the model must address the error first.
 */
export function unresolvedToolErrors(messages: readonly Message[]): StopDecision | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user" || !msg.blocks) continue;
    const results = msg.blocks.filter((b) => "tool_use_id" in b);
    if (results.length === 0) continue;

    const hasError = results.some((b) => "is_error" in b && (b as { is_error?: boolean }).is_error);
    if (hasError) {
      return {
        continue: true,
        reason:
          "At least one tool returned an error. Please address the error before stopping. " +
          "You can try an alternative approach, fix the input and retry, or explain why the error is not blocking.",
      };
    }
    break;
  }
  return undefined;
}

// ─── LLM goal evaluation ───

const EMPTY_SUMMARY: WorkSummary = {
  changed_files: [],
  commands_run: [],
  test_result: "unknown",
  summary: "",
};

/** Ask a small model to summarise the last 10 messages as structured JSON. */
export async function extractStructuredSummary(
  model: ChatModel,
  messages: readonly Message[],
): Promise<WorkSummary> {
  const recent = messages.slice(-10);
  const prompt: Message = {
    role: "user",
    text: [
      "Based on the recent conversation, extract a structured summary as JSON:",
      '{ changed_files: string[], commands_run: string[], test_result: "pass" | "fail" | "unknown", summary: string }',
    ].join("\n"),
  };

  try {
    const result = await collectStream(model.stream([...recent, prompt], { tools: [] as const }));
    const text = extractText({ blocks: result.blocks }).trim();
    // Extract first {...} block — model may wrap in markdown fences
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return EMPTY_SUMMARY;
    const parsed = JSON.parse(jsonMatch[0]) as Partial<WorkSummary>;
    return {
      changed_files: Array.isArray(parsed.changed_files) ? parsed.changed_files : [],
      commands_run: Array.isArray(parsed.commands_run) ? parsed.commands_run : [],
      test_result: parsed.test_result ?? "unknown",
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    };
  } catch {
    return EMPTY_SUMMARY;
  }
}

export interface GoalEvaluation {
  met: boolean;
  reason: string;
}

/** Ask the evaluator model whether the goal condition has been met. */
export async function evaluateGoal(
  model: ChatModel,
  summary: WorkSummary,
  condition: string,
): Promise<GoalEvaluation> {
  const prompt: Message = {
    role: "user",
    text: [
      "You are a goal evaluator.",
      `Work summary: ${JSON.stringify(summary)}`,
      `Goal condition: ${condition}`,
      "Reply with JSON: { met: boolean, reason: string }",
    ].join("\n"),
  };

  try {
    const result = await collectStream(model.stream([prompt], { tools: [] as const }));
    const text = extractText({ blocks: result.blocks }).trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { met: false, reason: "evaluation failed" };
    const parsed = JSON.parse(jsonMatch[0]) as { met?: boolean; reason?: string };
    return {
      met: parsed.met === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "evaluation failed",
    };
  } catch {
    return { met: false, reason: "evaluation failed" };
  }
}

// ─── Plugin factory ───

/**
 * Goal guard plugin: deterministic error gate + optional LLM goal evaluation.
 *
 * beforeStop pipeline:
 * 1. unresolvedToolErrors — veto stop if a tool returned is_error
 * 2. extraValidators — caller-supplied deterministic checks
 * 3. LLM goal evaluation — only if goalCondition + evaluatorModel are set
 */
export function goalPlugin(opts?: GoalPluginOptions): Plugin {
  const goalCondition = opts?.goalCondition;
  const evaluatorModel = opts?.evaluatorModel;
  const extraValidators = opts?.extraValidators ?? [];
  const onEvaluation = opts?.onEvaluation;

  return definePlugin({
    name: "goal",
    hooks: {
      beforeStop: async (_ctx: HookContext, messages: readonly Message[]) => {
        // Step 1: deterministic error gate
        const errorCheck = unresolvedToolErrors(messages);
        if (errorCheck) return errorCheck;

        // Step 2: extra validators
        for (const validator of extraValidators) {
          const result = await validator(messages);
          if (result) return result;
        }

        // Step 3: resolve condition (static string or dynamic getter)
        const condition = typeof goalCondition === "function" ? goalCondition() : goalCondition;
        if (!condition || !evaluatorModel) return undefined;

        const summary = await extractStructuredSummary(evaluatorModel, messages);
        const evaluation = await evaluateGoal(evaluatorModel, summary, condition);

        onEvaluation?.({ summary, evaluation });

        if (!evaluation.met) {
          return { continue: true, reason: evaluation.reason };
        }
        return undefined;
      },
    },
  });
}
