// src/tools/ask-user-question.ts
import { z } from 'zod';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { ZodTool } from './zod-tool';

const MAX_TAB_LABEL_LENGTH = 12;
const MAX_OPTIONS_COUNT = 4;
const MAX_OPTIONS_PER_QUESTION = 4;

/**
 * A single selectable choice inside a question.
 */
export type AskUserQuestionOption = z.infer<typeof askUserQuestionOptionSchema>;

/**
 * A single question presented to the user.
 */
export type AskUserQuestionItem = z.infer<typeof askUserQuestionItemSchema>;

/**
 * Input parameters for the `ask_user_question` tool.
 */
export type AskUserQuestionParameters = z.infer<typeof askUserQuestionParametersSchema>;

export interface AskUserQuestionAnswer {
  question_index: number;
  selected_labels: string[];
}

export interface AskUserQuestionResult {
  answers: AskUserQuestionAnswer[];
}

const askUserQuestionOptionSchema = z.object({
  label: z.string().describe('Short display label for this choice (1–5 words).'),
  description: z.string().describe('What this choice means or implies.'),
  preview: z
    .string()
    .optional()
    .describe('Optional markdown preview when this option is focused (single-select only).'),
});

const askUserQuestionItemSchema = z.object({
  question: z.string().describe('Full question text; be specific and end with a question mark where appropriate.'),
  header: z
    .string()
    .max(MAX_TAB_LABEL_LENGTH)
    .describe(`Very short tab/tag label (max ${MAX_TAB_LABEL_LENGTH} characters), e.g. Auth, Library.`),
  options: z
    .array(askUserQuestionOptionSchema)
    .min(2)
    .max(MAX_OPTIONS_PER_QUESTION)
    .describe('2–4 distinct choices; mutually exclusive unless multi_select is true.'),
  multi_select: z
    .boolean()
    .describe('If true, the user may pick multiple options; if false, exactly one.'),
});

export const askUserQuestionParametersSchema = z.object({
  questions: z
    .array(askUserQuestionItemSchema)
    .min(1)
    .max(MAX_OPTIONS_COUNT)
    .describe('1–4 parallel, independent questions (no dependency between them).'),
});

function validateResultAgainstParams(params: AskUserQuestionParameters, result: AskUserQuestionResult): void {
  if (result.answers.length !== params.questions.length) {
    throw new Error(`ask_user_question: expected ${params.questions.length} answers, got ${result.answers.length}`);
  }
  const byIndex = new Map(result.answers.map((a) => [a.question_index, a]));
  for (let i = 0; i < params.questions.length; i++) {
    const q = params.questions[i]!;
    const a = byIndex.get(i);
    if (!a) {
      throw new Error(`ask_user_question: missing answer for question_index ${i}`);
    }
    const labels = new Set(q.options.map((o) => o.label));
    for (const l of a.selected_labels) {
      if (!labels.has(l)) {
        throw new Error(`ask_user_question: unknown label "${l}" for question ${i}`);
      }
    }
    if (q.multi_select) {
      if (a.selected_labels.length < 1) {
        throw new Error(`ask_user_question: multi-select question ${i} requires at least one selection`);
      }
    } else if (a.selected_labels.length !== 1) {
      throw new Error(`ask_user_question: single-select question ${i} requires exactly one selection`);
    }
  }
}

/**
 * Tool: ask the user one or more parallel multiple-choice questions (with optional multi-select).
 * Uses a global AskUserQuestionManager to coordinate with TUI.
 */
export class AskUserQuestionTool extends ZodTool<typeof askUserQuestionParametersSchema> {
  protected schema = askUserQuestionParametersSchema;
  protected name = 'ask_user_question';
  protected description =
    'Ask the user one or more independent questions with fixed choices. Prefer this over free-form questions when options are clear. ' +
    'Questions are parallel (no dependency between them). You may send 1–4 questions in one call. ' +
    'For each question set multi_select true only when multiple answers make sense. ' +
    'Emit this tool alone in its own response; do not batch with other tools.';
  readonly = false;
  conflictKey = () => 'ask_user_question:global';

  constructor(
    private readonly askCallback: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>,
  ) {
    super();
  }

  protected async handle(params: z.infer<typeof askUserQuestionParametersSchema>, _ctx: ToolContext): Promise<unknown> {
    const result = await this.askCallback(params);
    validateResultAgainstParams(params, result);
    return result;
  }
}

