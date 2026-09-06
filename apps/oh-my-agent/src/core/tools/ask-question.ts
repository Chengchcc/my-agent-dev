import type { AskQuestionInput, AskQuestionResult } from "@chengchenccc/agent-contract";
import type { PluginTool } from "../agent-runtime.js";

function normalizeInput(
  args: Readonly<Record<string, unknown>>,
): AskQuestionInput | { error: string } {
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: "questions must be a non-empty array" };
  const questions: AskQuestionInput["questions"] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) return { error: "each question must be an object" };
    const item = q as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.question !== "string") {
      return { error: "each question needs string id and question" };
    }
    const kind = item.kind === "text" ? "text" : "select";
    if (kind === "select") {
      const options = Array.isArray(item.options) ? item.options : [];
      if (options.length === 0) return { error: `question ${item.id}: select needs options` };
    }
    questions.push(item as unknown as AskQuestionInput["questions"][number]);
  }
  return { questions };
}

/** Native ask_question tool (oh-my-pi style). Executes through the HITL ask
 *  pipeline (`options.ask`); absent pipeline = fail closed. */
export function createAskQuestionTool(): PluginTool {
  return {
    name: "ask_question",
    description:
      "Ask the user structured questions and wait for answers. Questions are select (options, optional multi/recommended/other) or text (free input). Returns {answers:[{id,selectedValues,freeText}]}.",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique id for this question" },
              question: { type: "string", description: "The question text" },
              kind: { type: "string", enum: ["select", "text"] },
              options: {
                type: "array",
                items: { type: "string" },
                description: "Required when kind=select",
              },
            },
            required: ["id", "question"],
          },
        },
      },
      required: ["questions"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
      _signal?: AbortSignal,
      options?: {
        ask?: (input: AskQuestionInput) => Promise<AskQuestionResult | null>;
      },
    ): Promise<Readonly<Record<string, unknown>>> {
      const normalized = normalizeInput(args);
      if ("error" in normalized) return normalized;
      if (!options?.ask) return { error: "no ask pipeline configured" };
      const result = await options.ask(normalized);
      if (!result) return { error: "ask pipeline returned no answer" };
      return result as unknown as Record<string, unknown>;
    },
  };
}
