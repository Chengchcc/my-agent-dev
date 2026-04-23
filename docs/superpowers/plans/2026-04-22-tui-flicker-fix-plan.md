# TUI Flicker Optimization Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all identified performance and correctness issues from the initial TUI flicker optimization work.

**Architecture:** Follow the existing React/Ink TUI architecture. Fix issues in-place by modifying existing files: add `getModelName()` to Provider interface, accumulate usage per-turn, fix memoization, and use accurate token counting for context usage display.

**Tech Stack:** React + Ink for TUI, TypeScript, `@anthropic-ai/tokenizer` for token counting.

---

### Pre-requisite: Add dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add @anthropic-ai/tokenizer dependency**

```json
  "dependencies": {
    "@anthropic-ai/tokenizer": "^0.0.1",
```

- [ ] **Step 2: Install the dependency**

Run: `bun install`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add @anthropic-ai/tokenizer for token counting"
```

---

### Task 1: Fix TOOL_START Map reference issue

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx:407-408`

- [ ] **Step 1: Fix the dispatch to pass a Map snapshot**

Change:
```typescript
} else if (event.type === 'tool_call_start') {
  runningTools.set(event.toolCall.id, event);
  dispatch({ type: 'TOOL_START', runningTools });
```

To:
```typescript
} else if (event.type === 'tool_call_start') {
  runningTools.set(event.toolCall.id, event);
  dispatch({ type: 'TOOL_START', runningTools: new Map(runningTools) });
}
```

- [ ] **Step 2: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "fix(tui): pass Map snapshot to TOOL_START dispatch instead of reference"
```

---

### Task 2: Add usage field to TurnCompleteEvent and accumulate per turn

**Files:**
- Modify: `src/agent/loop-types.ts`
- Modify: `src/agent/Agent.ts`
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx`

- [ ] **Step 1: Add usage field to TurnCompleteEvent interface**

In `src/agent/loop-types.ts`, update the `TurnCompleteEvent`:

```typescript
/**
 * Turn complete - a single LLM invocation + tool execution (if any) has finished
 */
export interface TurnCompleteEvent extends AgentEventBase {
  type: 'turn_complete';
  hasToolCalls: boolean;
  /** Token usage from this turn */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}
```

- [ ] **Step 2: Update Agent.ts to yield usage in turn_complete**

In `src/agent/Agent.ts` line 391-398:

```typescript
// If no tool calls, we're done
if (!tool_calls || tool_calls.length === 0) {
  done = true;
  yield {
    type: 'turn_complete',
    turnIndex,
    hasToolCalls: false,
    usage,
  } satisfies AgentEvent;
  break;
}

// We have tool calls - yield turn complete
yield {
  type: 'turn_complete',
  turnIndex,
  hasToolCalls: true,
  usage,
} satisfies AgentEvent;
```

- [ ] **Step 3: Add TURN_COMPLETE action to agentUIReducer**

In `src/cli/tui/hooks/use-agent-loop.tsx`:

Add to `AgentUIAction` union:
```typescript
| { type: 'TURN_COMPLETE'; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
```

Update `agentUIReducer` switch:
```typescript
case 'TURN_COMPLETE':
  if (action.usage) {
    newTotalUsage = {
      promptTokens: state.totalUsage.promptTokens + action.usage.prompt_tokens,
      completionTokens: state.totalUsage.completionTokens + action.usage.completion_tokens,
      totalTokens: state.totalUsage.totalTokens + action.usage.total_tokens,
    };
    return { ...state, totalUsage: newTotalUsage };
  }
  return state;
```

- [ ] **Step 4: Handle turn_complete event in the loop**

In `src/cli/tui/hooks/use-agent-loop.tsx` inside the `for await (const event of agent.runAgentLoop(...))` loop:

Add:
```typescript
} else if (event.type === 'turn_complete') {
  dispatch({ type: 'TURN_COMPLETE', usage: event.usage });
```

Before the `agent_done` case:
```typescript
} else if (event.type === 'turn_complete') {
  dispatch({ type: 'TURN_COMPLETE', usage: event.usage });
} else if (event.type === 'sub_agent_start') {
```

- [ ] **Step 5: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/agent/loop-types.ts src/agent/Agent.ts src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "feat(tui): accumulate token usage on every turn"
```

---

### Task 3: Add current context token counting for Footer

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx`
- Modify: `src/cli/tui/components/Footer.tsx`

- [ ] **Step 1: Import tokenizer and calculate currentContextTokens**

At top of `use-agent-loop.tsx` add:
```typescript
import { countTokens } from '@anthropic-ai/tokenizer';
```

In `AgentLoopProvider` component:

Add after `tokenLimit` definition (around line 489-496):
```typescript
// Calculate current context token count
const currentContextTokens = useMemo(() => {
  return messages.reduce((sum, msg) => {
    return sum + countTokens(msg.content || '');
  }, 0);
}, [messages]);
```

Add `currentContextTokens` to the `AgentLoopState` type:
```typescript
/** Current approximate context token count */
currentContextTokens: number;
```

Add to the context value `value` object:
```typescript
const value = useMemo(
  () => ({
    agent,
    streaming,
    messages,
    todos,
    currentTools,
    runningSubAgents,
    completedSubAgents,
    focusedToolId,
    expandedTools,
    toolResults,
    totalUsage,
    currentContextTokens,
    tokenLimit,
    streamingStartTime,
    onSubmit,
    onSubmitWithSkill,
    abort,
    setTodos: (todos: UITodoItem[]) => dispatch({ type: 'SET_TODOS', todos }),
    focusTool,
    toggleFocusedTool,
    moveFocus,
  }),
  [agent, messages, onSubmit, onSubmitWithSkill, abort, streaming, todos, currentTools, runningSubAgents, completedSubAgents, focusedToolId, expandedTools, toolResults, totalUsage, currentContextTokens, tokenLimit, streamingStartTime, focusTool, toggleFocusedTool, moveFocus],
);
```

Update the dependency array to include `currentContextTokens`.

- [ ] **Step 2: Update Footer to use currentContextTokens**

In `src/cli/tui/components/Footer.tsx`:

```typescript
export function Footer() {
  const { totalUsage, currentContextTokens, tokenLimit } = useAgentLoop();

  const percentage = tokenLimit > 0 ? Math.round((currentContextTokens / tokenLimit) * 100) : 0;
  const barWidth = 20;
  const filled = tokenLimit > 0 ? Math.round(barWidth * currentContextTokens / tokenLimit) : 0;
  const empty = barWidth - filled;

  // Color based on percentage
  let color: 'gray' | 'yellow' | 'red' = 'gray';
  if (percentage > 80) {
    color = 'red';
  } else if (percentage > 60) {
    color = 'yellow';
  }

  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <Box marginTop={1} width="100%" justifyContent="space-between">
      <Text dimColor>Type /exit to quit, /clear to clear conversation</Text>
      <Box gap={1}>
        {totalUsage.totalTokens > 0 && (
          <>
            <Text dimColor>Total: {totalUsage.totalTokens.toLocaleString()}</Text>
            <Text dimColor>
              Context: <Text color={color}>{bar}</Text> {percentage}%
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}
```

**Note:** Changed "Tokens:" to "Total:" to clarify this is cumulative.

- [ ] **Step 3: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx src/cli/tui/components/Footer.tsx
git commit -m "feat(tui): show current context usage in footer with accurate token counting"
```

---

### Task 4: Add getModelName() to Provider interface and implement

**Files:**
- Modify: `src/types.ts`
- Modify: `src/providers/claude.ts`
- Modify: `src/providers/openai.ts`
- Modify: `src/agent/Agent.ts`

- [ ] **Step 1: Add getModelName() to Provider interface**

In `src/types.ts`, update the `Provider` interface:

```typescript
// Provider interface - all LLM providers must implement this
export interface Provider {
  registerTools(tools: Tool[]): void;
  invoke(context: AgentContext): Promise<LLMResponse>;
  stream(context: AgentContext, options?: { signal?: AbortSignal }): AsyncIterable<LLMResponseChunk>;
  /** Get the name of the model this provider uses */
  getModelName(): string;
}
```

- [ ] **Step 2: Implement in ClaudeProvider**

In `src/providers/claude.ts`:

Add the `model` private field declaration (already exists, just confirm):
```typescript
export class ClaudeProvider implements Provider {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private defaultMaxTokens: number;
  // ... existing code
```

Add the method at the end of the class:
```typescript
  getModelName(): string {
    return this.model;
  }
}
```

- [ ] **Step 3: Implement in OpenAIProvider**

In `src/providers/openai.ts`:

Same pattern:
```typescript
export class OpenAIProvider implements Provider {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private defaultMaxTokens: number;
  // ... existing code

  getModelName(): string {
    return this.model;
  }
}
```

- [ ] **Step 4: Add getModelName method to Agent class**

In `src/agent/Agent.ts`, add the method at the end before the closing brace:

```typescript
  /**
   * Get the name of the model from the provider.
   */
  getModelName(): string {
    return this.provider.getModelName();
  }
```

- [ ] **Step 5: Update Header to use getModelName**

In `src/cli/tui/components/Header.tsx`:

Change line 16-17:
```typescript
// Get model from config if available
const model = agent.getModelName();
```

- [ ] **Step 6: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/providers/claude.ts src/providers/openai.ts src/agent/Agent.ts src/cli/tui/components/Header.tsx
git commit -m "feat(tui): add getModelName() to Provider interface, Header always shows model"
```

---

### Task 5: Fix StreamingIndicator issues

**Files:**
- Modify: `src/cli/tui/components/StreamingIndicator.tsx`

- [ ] **Step 1: Merge useAgentLoop calls, fix turn counting, reduce refresh rate**

Full updated `StreamingIndicator`:

```typescript
import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime, messages } = useAgentLoop();
  const [, forceUpdate] = useState({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (streaming && streamingStartTime) {
      // Refresh at 500ms interval instead of 100ms - enough for second accuracy
      intervalRef.current = setInterval(() => {
        forceUpdate({});
      }, 500);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming, streamingStartTime]);

  if (!streaming) return null;

  const elapsedMs = streamingStartTime ? Date.now() - streamingStartTime : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  // Turn count = number of completed assistant messages + this current turn
  const turnCount = messages.filter(m => m.role === 'assistant').length;

  return (
    <Box gap={2}>
      <BlinkingText color="gray">⠋ Thinking...</BlinkingText>
      <Text dimColor>Turn {turnCount}</Text>
      <Text dimColor>{elapsedSec}s</Text>
      {nextTodo && <Text dimColor>Next: {nextTodo}</Text>}
    </Box>
  );
}
```

Changes:
- Merged two `useAgentLoop()` calls into one
- Reduced interval from 100ms → 500ms
- Kept turn counting from messages but it's now only calculated on render (once per 500ms, which is fine)

- [ ] **Step 2: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/StreamingIndicator.tsx
git commit -m "fix(tui): merge useAgentLoop calls and reduce refresh frequency to 500ms"
```

---

### Task 6: Fix ToolCallWrapper re-rendering with useMemo

**Files:**
- Modify: `src/cli/tui/components/ChatMessage.tsx`

- [ ] **Step 1: Memoize ToolCallWrapper output**

Update the `ToolCallWrapper` component:

```typescript
function ToolCallWrapper({ toolCall }: { toolCall: ToolCall }) {
  const { focusedToolId, expandedTools, toolResults, currentTools, messages: allMessages } = useAgentLoop();

  const result = useMemo(() => {
    const expanded = expandedTools.has(toolCall.id);
    const focused = focusedToolId === toolCall.id;
    const resultMeta = toolResults.get(toolCall.id);
    const toolMsg = allMessages.find(m => m.role === 'tool' && m.tool_call_id === toolCall.id);
    const pending = currentTools.some(t => t.toolCall.id === toolCall.id);

    let output: { content: string; isError: boolean; durationMs: number } | undefined;
    if (toolMsg?.content) {
      output = {
        content: toolMsg.content,
        isError: resultMeta?.isError ?? false,
        durationMs: resultMeta?.durationMs ?? 0,
      };
    }

    return (
      <Box marginY={1}>
        <ToolCallMessage
          toolCall={toolCall}
          result={output}
          pending={pending}
          focused={focused}
          expanded={expanded}
        />
      </Box>
    );
  }, [toolCall.id, focusedToolId, expandedTools, toolResults, currentTools, allMessages]);

  return result;
}
```

This way, the component only re-renders when something specific to this tool changes.

- [ ] **Step 2: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/ChatMessage.tsx
git commit -m "perf(tui): memoize ToolCallWrapper to avoid unnecessary re-renders"
```

---

### Task 7: Remove unused interval prop from BlinkingText

**Files:**
- Modify: `src/cli/tui/components/BlinkingText.tsx`

- [ ] **Step 1: Remove interval prop from interface and component**

Full updated `BlinkingText.tsx`:

```typescript
import React from 'react';
import { Text } from 'ink';
import type { TextProps } from 'ink';
import { useBlink } from './BlinkContext';

export interface BlinkingTextProps extends TextProps {
}

export function BlinkingText({
  children,
  ...props
}: BlinkingTextProps) {
  // Blinking is controlled by BlinkContext at the app level
  const visible = useBlink();

  if (visible) {
    return <Text {...props}>{children}</Text>;
  }

  return <Text {...props} dimColor>{children}</Text>;
}
```

- [ ] **Step 2: Check that App still compiles**

App.tsx uses `<BlinkProvider interval={800}>`, which is still correct. No changes needed there.

Run: `bun run tsc`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/BlinkingText.tsx
git commit -m "cleanup(tui): remove unused interval prop from BlinkingText"
```

---

### Task 8: Final verification and test run

**Files:**
- Verify all changes

- [ ] **Step 1: Full TypeScript compile**

Run: `bun run tsc`
Expected: All clean, no errors

- [ ] **Step 2: Start dev TUI to verify basic functionality**

Run: `bun run tui`
Expected: Starts successfully, no runtime errors

- [ ] **Step 3: Verify all displays**
  - Header shows model name correctly
  - Blinking text still blinks at correct interval
  - Footer shows Total tokens and Context bar
  - Streaming indicator updates elapsed time

- [ ] **Step 4: Commit nothing - just verify**

---

## Self-Check

All 8 issues from the spec are covered:
1. ✅ TOOL_START Map snapshot ✓ Task 1
2. ✅ Accumulate usage per turn ✓ Task 2
3. ✅ Footer context usage ✓ Task 3
4. ✅ StreamingIndicator 500ms refresh ✓ Task 5
5. ✅ Header model name ✓ Task 4
6. ✅ ToolCallWrapper memo ✓ Task 6
7. ✅ BlinkingText remove interval prop ✓ Task 7
8. ✅ Merge useAgentLoop calls ✓ Task 5

No placeholders, all code shown, all file paths exact.
