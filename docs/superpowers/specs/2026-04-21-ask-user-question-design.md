# AskUserQuestion Tool with TUI Support Design

Date: 2026-04-21

## Overview

Add an `ask_user_question` tool that allows the agent to ask the user one or more multiple-choice questions directly through the TUI. Supports both single-select and multi-select questions. This design follows the helixent implementation pattern closely.

## Architecture

### 1. Tool Definition (`src/tools/ask-user-question.ts`)

Extends our existing `ZodTool` base class with:

**Types:**
- `AskUserQuestionOption` - `{ label: string; description: string; preview?: string }`
- `AskUserQuestionItem` - `{ question: string; header: string; options: AskUserQuestionOption[]; multi_select: boolean }`
- `AskUserQuestionParameters` - `{ questions: AskUserQuestionItem[] }` (1-4 questions)
- `AskUserQuestionAnswer` - `{ question_index: number; selected_labels: string[] }`
- `AskUserQuestionResult` - `{ answers: AskUserQuestionAnswer[] }`

**Zod Schema:**
- Follows helixent validation exactly: 1-4 questions, 2-4 options per question, max 12 chars for header
- Result validation ensures correct number of answers, valid labels, and proper selection counts

### 2. Question Manager (`src/tools/ask-user-question-manager.ts`)

- `AskUserQuestionManager` class with:
  - Queue of pending questions (max 20)
  - `askUserQuestion(params: AskUserQuestionParameters): Promise<AskUserQuestionResult>`
  - `respondWithAnswers(result: AskUserQuestionResult): void`
  - `subscribe(callback: (req: AskUserQuestionRequest | null) => void): () => void`
- Export `globalAskUserQuestionManager` singleton

The manager processes one question at a time and notifies subscribers when the pending question changes.

### 3. TUI React Hook (`src/cli/tui/hooks/use-ask-user-question-manager.ts`)

- Custom hook that subscribes to `globalAskUserQuestionManager`
- Returns `{ askUserQuestionRequest, respondWithAnswers }`
- Re-renders when pending question changes

### 4. TUI Prompt Component (`src/cli/tui/components/AskUserQuestionPrompt.tsx`)

Full interactive component with keyboard navigation:

**Features:**
- Renders as a bordered box at the bottom of the screen
- For multiple questions: tabbed interface with left/right arrow navigation
- Final "Review" tab for reviewing all answers before submission
- Keyboard controls:
  - ↑/↓: Navigate options within a question
  - Space: Toggle selection (multi-select only)
  - ←/→: Switch between question tabs (when multiple questions)
  - Enter: Next tab / Submit when on review tab
- Visual feedback:
  - Selected options show checkboxes for multi-select
  - Focused option is highlighted cyan
  - Option description shown when focused
  - Optional markdown preview for single-select focused options

### 5. Integration

1. **`src/tools/index.ts`** - Export the tool and manager
2. **`bin/my-agent-tui-dev.ts` / `bin/my-agent-tui`** - Register the tool with the ToolRegistry using the global manager
3. **`src/cli/tui/components/App.tsx`** - Add the prompt component that renders when there's a pending question

## Data Flow

```
LLM calls ask_user_question tool
  ↓
tool calls globalAskUserQuestionManager.askUserQuestion()
  ↓manager adds to queue and notifies subscribers
React hook receives request → re-renders App
  ↓
App renders AskUserQuestionPrompt with the question
  ↓user interacts and submits
AskUserQuestionPrompt calls respondWithAnswers(result)
  ↓manager resolves the promise
tool returns result to LLM
```

## Compliance with Existing Patterns

- Uses our existing `ZodTool` base class for tool implementation
- Follows our existing Ink/React component patterns
- Doesn't require changes to core `Agent` class
- Leverages the existing event subscription pattern
- Keyboard navigation matches existing TUI conventions

## Success Criteria

- [ ] LLM can invoke `ask_user_question` with 1-4 questions
- [ ] Questions appear as an interactive prompt in the TUI
- [ ] Keyboard navigation works as expected
- [ ] Single-select: exactly one selection per question
- [ ] Multi-select: at least one selection, multiple allowed
- [ ] Answer is returned correctly to the tool/LLM
- [ ] TypeScript compiles without errors
