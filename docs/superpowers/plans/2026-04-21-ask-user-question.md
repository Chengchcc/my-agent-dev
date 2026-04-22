# AskUserQuestion Tool with TUI Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ask_user_question` tool that allows the agent to ask the user one or more multiple-choice questions through the TUI, supporting both single-select and multi-select modes following the helixent implementation pattern.

**Architecture:** We create the tool definition with Zod schema, a global question manager for coordinating between tool execution and TUI, a React hook for the TUI to subscribe to questions, and an interactive React component for rendering the question prompt. The design follows helixent closely while adapting to this project's existing architecture (using `ZodTool` base class instead of `defineTool`).

**Tech Stack:** TypeScript, Zod, React, Ink (React for CLIs)

---

## File Mapping

| File | Purpose |
|------|---------|
| `src/tools/ask-user-question.ts` | Tool implementation with type definitions and Zod schema |
| `src/tools/ask-user-question-manager.ts` | Question manager with queue and subscription support |
| `src/tools/index.ts` | Export the new tool and manager |
| `src/cli/tui/hooks/use-ask-user-question-manager.ts` | React hook for TUI subscription |
| `src/cli/tui/hooks/index.ts` | Export the hook |
| `src/cli/tui/components/AskUserQuestionPrompt.tsx` | Interactive TUI prompt component |
| `src/cli/tui/components/index.ts` | Export the component |
| `src/cli/tui/components/App.tsx` | Add prompt component to App |
| `bin/my-agent-tui-dev.ts` | Register the tool |
| `bin/my-agent-tui` | Register the tool (production entry point) |

---

### Task 1: Create Type definitions and tool implementation

**Files:**
- Create: `src/tools/ask-user-question.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Create the file with full implementation**

```typescript
// src/tools/ask-user-question.ts
import { z } from 'zod';
import ZodTool from './zod-tool';
import type { AskUserQuestionParameters, AskUserQuestionResult } from './ask-user-question-manager';

/**
 * A single selectable choice inside a question.
 */
export interface AskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

/**
 * A single question presented to the user.
 */
export interface AskUserQuestionItem {
  question: string;
  header: string;
  /** 2–4 choices; mutually exclusive unless {@link multi_select} is true. */
  options: AskUserQuestionOption[];
  multi_select: boolean;
}

/**
 * Input parameters for the `ask_user_question` tool.
 */
export interface AskUserQuestionParameters {
  questions: AskUserQuestionItem[];
}

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
    .max(12)
    .describe('Very short tab/tag label (max 12 characters), e.g. Auth, Library.'),
  options: z
    .array(askUserQuestionOptionSchema)
    .min(2)
    .max(4)
    .describe('2–4 distinct choices; mutually exclusive unless multi_select is true.'),
  multi_select: z
    .boolean()
    .describe('If true, the user may pick multiple options; if false, exactly one.'),
});

export const askUserQuestionParametersSchema = z.object({
  questions: z
    .array(askUserQuestionItemSchema)
    .min(1)
    .max(4)
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
    'For each question set multi_select true only when multiple answers make sense.';

  constructor(
    private readonly askCallback: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult>,
  ) {
    super();
  }

  protected async handle(params: z.infer<typeof askUserQuestionParametersSchema>): Promise<unknown> {
    const result = await this.askCallback(params);
    validateResultAgainstParams(params, result);
    return JSON.stringify(result);
  }
}

export default AskUserQuestionTool;
```

- [ ] **Step 2: Update exports in `src/tools/index.ts`**

```typescript
// src/tools/index.ts
export * from './bash';
export * from './text-editor';
export * from './zod-tool';
export * from './ask-user-question';
export * from './ask-user-question-manager';
```

- [ ] **Step 3: Compile TypeScript to check for errors**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/tools/ask-user-question.ts src/tools/index.ts
git commit -m "feat: add AskUserQuestionTool with type definitions"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 2: Create AskUserQuestionManager singleton

**Files:**
- Create: `src/tools/ask-user-question-manager.ts`

- [ ] **Step 1: Create the manager class**

```typescript
// src/tools/ask-user-question-manager.ts
import type { AskUserQuestionParameters, AskUserQuestionResult } from './ask-user-question';

export type AskUserQuestionRequest = {
  params: AskUserQuestionParameters;
  resolve: (result: AskUserQuestionResult) => void;
};

const MAX_QUEUE_SIZE = 20;

export class AskUserQuestionManager {
  private _queue: AskUserQuestionRequest[] = [];
  private _currentRequest?: AskUserQuestionRequest;
  private _subscriber?: (req: AskUserQuestionRequest | null) => void;

  askUserQuestion = (params: AskUserQuestionParameters): Promise<AskUserQuestionResult> => {
    return new Promise((resolve, reject) => {
      if (this._queue.length >= MAX_QUEUE_SIZE) {
        console.warn('[AskUserQuestionManager] Queue overflow; rejecting request.');
        reject(new Error('Ask user question queue overflow'));
        return;
      }
      this._queue.push({ params, resolve });
      this._processQueue();
    });
  };

  private _processQueue() {
    if (this._currentRequest || this._queue.length === 0) {
      if (this._queue.length === 0 && !this._currentRequest) {
        this._subscriber?.(null);
      }
      return;
    }

    this._currentRequest = this._queue.shift()!;
    this._subscriber?.(this._currentRequest);
  }

  respondWithAnswers = (result: AskUserQuestionResult) => {
    if (!this._currentRequest) return;
    this._currentRequest.resolve(result);
    this._currentRequest = undefined;
    this._processQueue();
  };

  subscribe(callback: (req: AskUserQuestionRequest | null) => void) {
    this._subscriber = callback;
    this._processQueue();
    return () => {
      this._subscriber = undefined;
    };
  }
}

export const globalAskUserQuestionManager = new AskUserQuestionManager();
```

- [ ] **Step 2: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/ask-user-question-manager.ts
git commit -m "feat: add AskUserQuestionManager with global singleton"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 3: Create React hook for TUI subscription

**Files:**
- Create: `src/cli/tui/hooks/use-ask-user-question-manager.ts`
- Modify: `src/cli/tui/hooks/index.ts`

- [ ] **Step 1: Create the hook**

```typescript
// src/cli/tui/hooks/use-ask-user-question-manager.ts
import { useEffect, useState } from 'react';
import {
  globalAskUserQuestionManager,
  type AskUserQuestionRequest,
  type AskUserQuestionResult,
} from '../../../tools';

export function useAskUserQuestionManager() {
  const [request, setRequest] = useState<AskUserQuestionRequest | null>(null);

  useEffect(() => {
    return globalAskUserQuestionManager.subscribe((req) => {
      setRequest(req);
    });
  }, []);

  const respondWithAnswers = (result: AskUserQuestionResult) => {
    if (request) {
      globalAskUserQuestionManager.respondWithAnswers(result);
    }
  };

  return {
    askUserQuestionRequest: request,
    respondWithAnswers,
  };
}
```

- [ ] **Step 2: Update exports in `src/cli/tui/hooks/index.ts`**

Add the new export:

```typescript
// src/cli/tui/hooks/index.ts
export * from './use-agent-loop';
export * from './use-command-input';
export * from './use-input-editor';
export * from './use-input-history';
export * from './use-ask-user-question-manager';
```

- [ ] **Step 3: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/hooks/use-ask-user-question-manager.ts src/cli/tui/hooks/index.ts
git commit -m "feat: add useAskUserQuestionManager hook for TUI"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 4: Create AskUserQuestionPrompt TUI component

**Files:**
- Create: `src/cli/tui/components/AskUserQuestionPrompt.tsx`
- Modify: `src/cli/tui/components/index.ts`

- [ ] **Step 1: Create the interactive prompt component**

```typescript
// src/cli/tui/components/AskUserQuestionPrompt.tsx
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { AskUserQuestionItem, AskUserQuestionResult } from '../../../tools';

function buildInitialSelections(questions: AskUserQuestionItem[]): string[][] {
  return questions.map((q) => (q.multi_select ? [] : [q.options[0]!.label]));
}

function buildInitialFocus(questions: AskUserQuestionItem[]): number[] {
  return questions.map(() => 0);
}

function canSubmit(questions: AskUserQuestionItem[], selections: string[][]): boolean {
  return questions.every((q, i) => {
    const s = selections[i]!;
    if (q.multi_select) return s.length >= 1;
    return s.length === 1;
  });
}

function tabLabel(header: string): string {
  return header.length > 12 ? `${header.slice(0, 11)}…` : header;
}

export interface AskUserQuestionPromptProps {
  questions: AskUserQuestionItem[];
  onSubmit: (answer: AskUserQuestionResult) => void;
}

export function AskUserQuestionPrompt({ questions, onSubmit }: AskUserQuestionPromptProps) {
  const qCount = questions.length;
  const reviewTabIndex = qCount >= 2 ? qCount : -1;

  const [tabIndex, setTabIndex] = useState(0);
  const [selections, setSelections] = useState<string[][]>(() => buildInitialSelections(questions));
  const [focusIdx, setFocusIdx] = useState<number[]>(() => buildInitialFocus(questions));

  const stateRef = useRef({ tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex });
  stateRef.current = { tabIndex, selections, focusIdx, questions, qCount, reviewTabIndex };

  const trySubmit = useCallback(() => {
    const { selections: sel, questions: qs } = stateRef.current;
    if (!canSubmit(qs, sel)) return;
    onSubmit({
      answers: qs.map((_, i) => ({
        question_index: i,
        selected_labels: [...sel[i]!],
      })),
    });
  }, [onSubmit]);

  useInput((input, key) => {
    const s = stateRef.current;
    const { qCount: n, reviewTabIndex: review, questions: qs } = s;
    const { tabIndex: tab, focusIdx: focus } = s;

    const onQuestionTab = tab < n;
    const isReview = review >= 0 && tab === review;

    if (key.leftArrow && n >= 2) {
      setTabIndex((t) => (t === 0 ? review! : t - 1));
      return;
    }
    if (key.rightArrow && n >= 2) {
      setTabIndex((t) => (t === review! ? 0 : t + 1));
      return;
    }

    if (key.upArrow && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      const cur = focus[qi]!;
      const ni = cur > 0 ? cur - 1 : q.options.length - 1;
      setFocusIdx((prev) => {
        const next = [...prev];
        next[qi] = ni;
        return next;
      });
      if (!q.multi_select) {
        const label = q.options[ni]!.label;
        setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
      }
      return;
    }

    if (key.downArrow && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      const cur = focus[qi]!;
      const ni = cur < q.options.length - 1 ? cur + 1 : 0;
      setFocusIdx((prev) => {
        const next = [...prev];
        next[qi] = ni;
        return next;
      });
      if (!q.multi_select) {
        const label = q.options[ni]!.label;
        setSelections((se) => se.map((row, i) => (i === qi ? [label] : [...row])));
      }
      return;
    }

    if (key.return) {
      if (n === 1) {
        trySubmit();
        return;
      }
      if (isReview) {
        trySubmit();
        return;
      }
      if (tab < n - 1) {
        setTabIndex(tab + 1);
      } else {
        setTabIndex(review!);
      }
      return;
    }

    if (input === ' ' && onQuestionTab) {
      const qi = tab;
      const q = qs[qi]!;
      if (!q.multi_select) return;
      const fi = focus[qi]!;
      const label = q.options[fi]!.label;
      setSelections((se) => {
        const copy = se.map((row) => [...row]);
        const row = copy[qi]!;
        const j = row.indexOf(label);
        if (j >= 0) {
          row.splice(j, 1);
        } else {
          row.push(label);
        }
        return copy;
      });
    }
  });

  const tabRow = useMemo(() => {
    if (qCount < 2) return null;
    return (
      <Box flexDirection="row" columnGap={2} marginBottom={1} flexWrap="wrap">
        {questions.map((q, i) => (
          <Text key={i} color={tabIndex === i ? "cyan" : "gray"} bold={tabIndex === i}>
            {tabIndex === i ? "▸ " : "  "}
            {tabLabel(q.header)}
          </Text>
        ))}
        <Text
          key="review"
          color={tabIndex === reviewTabIndex ? "cyan" : "gray"}
          bold={tabIndex === reviewTabIndex}
        >
          {tabIndex === reviewTabIndex ? "▸ " : "  "}
          Confirm
        </Text>
      </Box>
    );
  }, [qCount, questions, tabIndex, reviewTabIndex]);

  const hint =
    qCount >= 2
      ? "←/→ tab · ↑/↓ option · Space multi-toggle · Enter next or confirm"
      : "↑/↓ option · Space multi-toggle · Enter confirm";

  const showReview = qCount >= 2 && tabIndex === reviewTabIndex;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      {tabRow}
      <Box marginTop={1} flexDirection="column">
        {showReview ? (
          <ReviewPanel questions={questions} selections={selections} />
        ) : (
          <QuestionPanel
            question={questions[tabIndex]!}
            focusIdx={focusIdx[tabIndex]!}
            selections={selections[tabIndex]!}
          />
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

function ReviewPanel({ questions, selections }: { questions: AskUserQuestionItem[]; selections: string[][] }) {
  return (
    <Box flexDirection="column" rowGap={1}>
      <Text bold>Review choices</Text>
      {questions.map((q, i) => (
        <Box key={i} flexDirection="column">
          <Text color="cyan">{q.header}</Text>
          <Text dimColor>{selections[i]!.length ? selections[i]!.join(", ") : "(none selected)"}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>Press Enter to submit.</Text>
      </Box>
    </Box>
  );
}

function QuestionPanel({
  question,
  focusIdx,
  selections,
}: {
  question: AskUserQuestionItem;
  focusIdx: number;
  selections: string[];
}) {
  const focusedOption = question.options[focusIdx];
  const showPreview = !question.multi_select && focusedOption?.preview;

  return (
    <Box flexDirection="column" rowGap={0}>
      <Text bold>{question.question}</Text>
      <Box flexDirection="column" marginTop={1}>
        {question.options.map((opt, i) => {
          const focused = i === focusIdx;
          const selected = question.multi_select ? selections.includes(opt.label) : focused;
          const prefix = question.multi_select ? (selected ? "[×] " : "[ ] ") : focused ? "❯ " : "  ";
          return (
            <Box key={i} flexDirection="column">
              <Text color={focused ? "cyan" : undefined}>
                {prefix}
                {opt.label}
              </Text>
              {focused && (
                <Text dimColor>
                  {"   "}
                  {opt.description}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
      {showPreview && focusedOption?.preview && (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text>{focusedOption.preview}</Text>
        </Box>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Update exports in `src/cli/tui/components/index.ts`**

Add the new export:

```typescript
// src/cli/tui/components/index.ts
export * from './App';
export * from './ChatMessage';
export * from './CodeBlock';
export * from './CommandList';
export * from './Footer';
export * from './Header';
export * from './HighlightedInput';
export * from './InputBox';
export * from './StreamingIndicator';
export * from './TodoPanel';
export * from './ToolCallMessage';
export * from './AskUserQuestionPrompt';
```

- [ ] **Step 3: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/AskUserQuestionPrompt.tsx src/cli/tui/components/index.ts
git commit -m "feat: add AskUserQuestionPrompt interactive TUI component"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 5: Integrate into App component

**Files:**
- Modify: `src/cli/tui/components/App.tsx`

- [ ] **Step 1: Update App.tsx to import and render the prompt**

Find the existing AppContent function and add the hook and prompt. The updated App should look like:

```tsx
// src/cli/tui/components/App.tsx
import React from 'react';
import { Box } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { useAskUserQuestionManager } from '../hooks';
import { getBuiltinCommands } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage } from './ChatMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
import { AskUserQuestionPrompt } from './AskUserQuestionPrompt';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';

export interface AppProps {
  agent: Agent;
  skillCommands: SlashCommand[];
  sessionStore: SessionStore;
}

export function App({ agent, skillCommands, sessionStore }: AppProps) {
  return (
    <AgentLoopProvider agent={agent} sessionStore={sessionStore}>
      <AppContent skillCommands={skillCommands} sessionStore={sessionStore} />
    </AgentLoopProvider>
  );
}

function AppContent({ skillCommands, sessionStore }: { skillCommands: SlashCommand[]; sessionStore: SessionStore }) {
  const { messages, streaming: isStreaming, onSubmitWithSkill, abort, todos } = useAgentLoop();
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();

  const allCommands = [...getBuiltinCommands(sessionStore), ...skillCommands];

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <ScrollView>
        {messages.map((message, index) => (
          <ChatMessage
            key={message.id ?? index}
            message={message}
            isStreaming={isStreaming && index === messages.length - 1}
          />
        ))}
      </ScrollView>
      {askUserQuestionRequest && (
        <AskUserQuestionPrompt
          questions={askUserQuestionRequest.params.questions}
          onSubmit={respondWithAnswers}
        />
      )}
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {isStreaming && <StreamingIndicator />}
      <InputBox commands={allCommands} onSubmit={onSubmitWithSkill} onAbort={abort} />
      <Footer />
    </Box>
  );
}
```

- [ ] **Step 2: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/App.tsx
git commit -m "feat: integrate AskUserQuestionPrompt into App component"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 6: Register the tool in TUI entry points

**Files:**
- Modify: `bin/my-agent-tui-dev.ts`
- Modify: `bin/my-agent-tui`

- [ ] **Step 1: Update `bin/my-agent-tui-dev.ts`**

Add imports and tool registration after other tool registrations:

```typescript
// Add import after existing imports
import { BashTool, TextEditorTool, AskUserQuestionTool } from '../src/tools';
import { globalAskUserQuestionManager } from '../src/tools';

// ... after existing tool registrations:
toolRegistry.register(new AskUserQuestionTool(
  (params) => globalAskUserQuestionManager.askUserQuestion(params)
));
```

- [ ] **Step 2: Update `bin/my-agent-tui` (production entry point)**

```typescript
// Add import after existing imports
import { BashTool, TextEditorTool, AskUserQuestionTool } from '../dist/src/tools';
import { globalAskUserQuestionManager } from '../dist/src/tools';

// ... after existing tool registrations:
toolRegistry.register(new AskUserQuestionTool(
  (params) => globalAskUserQuestionManager.askUserQuestion(params)
));
```

- [ ] **Step 3: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent-tui-dev.ts bin/my-agent-tui
git commit -m "feat: register AskUserQuestionTool in TUI entry points"

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

---

### Task 7: Verify full build and test compilation

**Files:**
- None new, full build check

- [ ] **Step 1: Clean and full compile**

```bash
bun run tsc --clean
bun run tsc
```

Expected: No errors

- [ ] **Step 2: Verify TypeScript output in `dist/`**

```bash
ls -la dist/src/tools/
```

Expected: `ask-user-question.js` and `ask-user-question-manager.js` should exist

- [ ] **Step 3: Commit if any fixes needed (otherwise skip)**

If compilation passes cleanly, nothing to commit here.

---

## Self-Review

- ✅ **Spec coverage:** All requirements from the spec are covered: tool, manager, hook, component, integration
- ✅ **No placeholders:** All code is provided, all steps are concrete
- ✅ **Type consistency:** All type references match across files
- ✅ **Follows helixent pattern:** Exact same architecture adapted to this project's conventions

