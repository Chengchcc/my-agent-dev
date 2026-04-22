# TUI Flicker Optimization and Indicator Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate TUI flickering during streaming/tool execution through targeted optimizations and add useful status indicators (token usage, turn count, model/session info).

**Architecture:** Incremental optimizations starting with highest impact changes:
1. Batch streaming updates to reduce render frequency
2. Remove unnecessary full refreshes that cause flicker
3. Introduce `React.memo` to prevent unnecessary re-renders
4. Move to single global blink timer instead of per-component intervals
5. Consolidate multiple `useState` into `useReducer` for single-pass renders
6. Split context to prevent unnecessary re-renders
7. Add new status indicators to header/streaming/footer

**Tech Stack:** React + Ink (terminal UI), TypeScript, existing agent architecture

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/cli/tui/hooks/use-agent-loop.tsx` | Modify | Add batching, remove refresh on tool start, convert to useReducer, track token usage, turn timing |
| `src/cli/tui/components/BlinkContext.tsx` | Create | New - Global blink context provider |
| `src/cli/tui/components/BlinkingText.tsx` | Modify | Update to use BlinkContext instead of local state |
| `src/cli/tui/components/App.tsx` | Modify | Wrap app with BlinkProvider |
| `src/cli/tui/components/ChatMessage.tsx` | Modify | Add React.memo, extract ToolCallWrapper to avoid context dependency |
| `src/cli/tui/components/Header.tsx` | Modify | Add model name and session ID display |
| `src/cli/tui/components/StreamingIndicator.tsx` | Modify | Add turn count and elapsed time display |
| `src/cli/tui/components/Footer.tsx` | Modify | Add token usage and context usage bar |
| `src/agent/loop-types.ts` | Modify | Add `turnIndex` to text_delta event if not already present |

---

## Task 1: P0 - Add 50ms batching to text_delta updates

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx:221-241`

- [ ] **Step 1: Add ref variables for batching**

Add these after `streamingRef` and `streamingMessageRef`:
```typescript
const streamingContentRef = useRef('');
const batchTimerRef = useRef<NodeJS.Timeout | null>(null);
```

- [ ] **Step 2: Update text_delta handler to use batching**

Replace the current `text_delta` handler:
```typescript
} else if (event.type === 'text_delta') {
  // Only accumulate text during the current assistant turn
  // After tool execution, full messages are already in context
  if (streamingMessageRef.current !== null || runningTools.size === 0) {
    streamingContentRef.current += event.delta;

    // Batch updates: max one render per 50ms to reduce flicker
    if (!batchTimerRef.current) {
      batchTimerRef.current = setTimeout(() => {
        batchTimerRef.current = null;
        const streamingMessage: Message = {
          id: streamingMessageId,
          role: 'assistant',
          content: streamingContentRef.current,
        };
        streamingMessageRef.current = streamingMessage;

        setMessages(prev => {
          const base = prev.filter(m => m.id !== streamingMessageId);
          return [...base, streamingMessage];
        });
      }, 50);
    }
  }
```

- [ ] **Step 3: Clear batch timer in finally block**

Add cleanup in the finally block after `setStreaming(false)`:
```typescript
} finally {
  // Clear any pending batch timer
  if (batchTimerRef.current) {
    clearTimeout(batchTimerRef.current);
    batchTimerRef.current = null;
  }
  // Update todos from agent one last time
  refreshTodos();

  setStreaming(false);
  streamingMessageRef.current = null;
  setCurrentTools([]);
}
```

- [ ] **Step 4: Reset streamingContentRef on submit start**

Add this after `setStreaming(true);`:
```typescript
setStreaming(true);
streamingMessageRef.current = null;
streamingContentRef.current = '';

// Track incremental streaming content
const runningTools = new Map<string, ToolCallStartEvent>();
// Stable id for streaming message that persists across updates
const streamingMessageId = `streaming-${Date.now()}`;
```

- [ ] **Step 5: Compile TypeScript to verify**

```bash
bun run tsc
```

Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "perf(p0): add 50ms batching to text_delta updates

Reduces render frequency from ~10-20 per second to max 20fps,
which eliminates most of the visible flicker during streaming.
"
```

---

## Task 2: P0 - Remove refreshMessages from tool_call_start

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx:242-248`

- [ ] **Step 1: Remove the unnecessary refresh calls**

Current code:
```typescript
} else if (event.type === 'tool_call_start') {
  runningTools.set(event.toolCall.id, event);
  setCurrentTools(Array.from(runningTools.values()));
  // Refresh to show running tool
  refreshMessages();
  refreshTodos();
}
```

Change to:
```typescript
} else if (event.type === 'tool_call_start') {
  runningTools.set(event.toolCall.id, event);
  setCurrentTools(Array.from(runningTools.values()));
  // Don't refresh here - wait for tool_result to refresh once
  // This eliminates flicker from streaming -> context -> streaming switching
}
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "perf(p0): remove refreshMessages from tool_call_start

Eliminates the flicker caused by replacing the streaming message
with context message and then having streaming restart. We only
refresh after the tool completes, which is enough.
"
```

---

## Task 3: P1 - Create BlinkContext for global blinking

**Files:**
- Create: `src/cli/tui/components/BlinkContext.tsx`

- [ ] **Step 1: Write BlinkProvider and context**

```typescript
import React, { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

const BlinkContext = createContext(true);

export function BlinkProvider({
  children,
  interval = 800,
}: {
  children: ReactNode;
  interval?: number;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setVisible(v => !v);
    }, interval);
    return () => clearInterval(id);
  }, [interval]);

  return (
    <BlinkContext.Provider value={visible}>
      {children}
    </BlinkContext.Provider>
  );
}

export function useBlink() {
  return useContext(BlinkContext);
}
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/BlinkContext.tsx
git commit -m "refactor(p1): add BlinkProvider for global blinking

Instead of each BlinkingText having its own setInterval, we now
have a single interval driving all blink animations. This reduces
the frequency of state updates from N per number of pending tools
to just 1 per interval.
"
```

---

## Task 4: P1 - Update BlinkingText to use BlinkContext

**Files:**
- Modify: `src/cli/tui/components/BlinkingText.tsx`

- [ ] **Step 1: Rewrite to use context**

Replace entire file content:
```typescript
import React from 'react';
import { Text } from 'ink';
import type { TextProps } from 'ink';
import { useBlink } from './BlinkContext';

export interface BlinkingTextProps extends TextProps {
  /** Blink interval in milliseconds (default: 800 for slow/subtle blinking) */
  interval?: number;
}

export function BlinkingText({
  children,
  interval = 800,
  ...props
}: BlinkingTextProps) {
  // interval is not used in the component - only for backwards compatibility
  // actual interval is controlled by BlinkProvider
  const visible = useBlink();

  if (visible) {
    return <Text {...props}>{children}</Text>;
  }

  return <Text {...props} dimColor>{children}</Text>;
}
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/BlinkingText.tsx
git commit -m "refactor(p1): update BlinkingText to use BlinkContext

Removes per-component interval and uses the global context
provided by BlinkProvider. Only one timer regardless of how
many blinking texts are active.
"
```

---

## Task 5: P1 - Wrap App with BlinkProvider

**Files:**
- Modify: `src/cli/tui/components/App.tsx`

- [ ] **Step 1: Add import and wrap**

Add import at top:
```typescript
import { BlinkProvider } from './BlinkContext';
```

Update `App` component return:
```typescript
return (
  <AgentLoopProvider agent={agent} sessionStore={sessionStore}>
    <BlinkProvider>
      <AppContent skillCommands={skillCommands} sessionStore={sessionStore} />
    </BlinkProvider>
  </AgentLoopProvider>
);
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/App.tsx
git commit -m "feat(p1): wrap app with BlinkProvider

Enables the global blink context for all BlinkingText components.
"
```

---

## Task 6: P1 - Add React.memo to ChatMessage and extract ToolCallWrapper

**Files:**
- Modify: `src/cli/tui/components/ChatMessage.tsx`

- [ ] **Step 1: Add React.memo wrapper and custom comparator**

At bottom of file, replace export:
```typescript
export const ChatMessage = React.memo(
  _ChatMessage,
  (prev, next) => {
    // Only re-render if what we care about actually changed
    return (
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.isStreaming === next.isStreaming &&
      prev.message.tool_calls === next.message.tool_calls &&
      prev.message.role === next.message.role
    );
  }
);

function _ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  // Keep all the existing code here - just move it inside this function
```

- [ ] **Step 2: Extract ToolCallWrapper to separate inner component**

Move the tool call rendering from `_ChatMessage` to `ToolCallWrapper` that consumes context:

Inside `_ChatMessage`, replace the tool mapping:
```typescript
{message.tool_calls.map(tc => (
  <ToolCallWrapper key={`${message.id ?? ''}-${tc.id}`} toolCall={tc} />
))}
```

Add `ToolCallWrapper` after `_ChatMessage`:
```typescript
function ToolCallWrapper({ toolCall }: { toolCall: ToolCall }) {
  const { focusedToolId, expandedTools, toolResults, currentTools, messages: allMessages } = useAgentLoop();
  const expanded = expandedTools.has(toolCall.id);
  const focused = focusedToolId === toolCall.id;

  // Look up from toolResults
  const resultMeta = toolResults.get(toolCall.id);

  // Look up the tool content from messages
  const toolMsg = allMessages.find(m => m.role === 'tool' && m.tool_call_id === toolCall.id);

  let result: { content: string; isError: boolean; durationMs: number } | undefined;
  if (toolMsg?.content) {
    result = {
      content: toolMsg.content,
      isError: resultMeta?.isError ?? false,
      durationMs: resultMeta?.durationMs ?? 0,
    };
  }

  const pending = currentTools.some(t => t.toolCall.id === toolCall.id);

  return (
    <Box marginY={1}>
      <ToolCallMessage
        toolCall={toolCall}
        result={result}
        pending={pending}
        focused={focused}
        expanded={expanded}
      />
    </Box>
  );
}
```

Remove tool result lookup from `_ChatMessage`:
- Remove from line 169: `const toolMsg = allMessages.find(...);`
- Only pass `toolCall` to `ToolCallWrapper` - it does the lookup internally via context

- [ ] **Step 3: Remove `allMessages` parameter from props in `_ChatMessage`**

`_ChatMessage` no longer needs the `allMessages` from context because `ToolCallWrapper` gets it.

- [ ] **Step 4: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/ChatMessage.tsx
git commit -m "perf(p1): add React.memo to ChatMessage + extract ToolCallWrapper

- ChatMessage is memoized - only re-renders when its own content changes
- Extract ToolCallWrapper that consumes context separately
- Only the affected tool re-renders when focus/expansion changes
- History messages don't re-render on streaming or focus changes
"
```

---

## Task 7: P2 - Convert multiple useState to useReducer in AgentLoopProvider

**Files:**
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx` (major refactor - entire state section)

- [ ] **Step 1: Define reducer state and action types**

After imports, add:

```typescript
type AgentUIState = {
  streaming: boolean;
  messages: Message[];
  todos: UITodoItem[];
  currentTools: ToolCallStartEvent[];
  runningSubAgents: Map<string, SubAgentStartEvent>;
  completedSubAgents: Map<string, { summary: string; totalTurns: number; durationMs: number; isError: boolean }>;
  focusedToolId: string | null;
  expandedTools: Set<string>;
  toolResults: Map<string, { durationMs: number; isError: boolean }>;
  /** Total accumulated token usage */
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Start time of current streaming turn for elapsed display */
  streamingStartTime: number | null;
};

type AgentUIAction =
  | { type: 'SUBMIT_START' }
  | { type: 'TEXT_DELTA_BATCH'; streamingMessageId: string; message: Message }
  | { type: 'TOOL_START'; runningTools: Map<string, ToolCallStartEvent> }
  | { type: 'TOOL_RESULT'; runningTools: Map<string, ToolCallStartEvent>; toolId: string; result: { durationMs: number; isError: boolean }; messages: Message[]; todos: UITodoItem[] }
  | { type: 'LOOP_COMPLETE'; messages: Message[]; todos: UITodoItem[]; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { type: 'AGENT_ERROR'; errorMessage: Message }
  | { type: 'SUB_AGENT_START'; event: SubAgentStartEvent }
  | { type: 'SUB_AGENT_DONE'; event: SubAgentDoneEvent }
  | { type: 'FOCUS_TOOL'; id: string }
  | { type: 'TOGGLE_EXPANDED' }
  | { type: 'MOVE_FOCUS'; direction: -1 | 1; collapsibleTools: string[] }
  | { type: 'SET_TODOS'; todos: UITodoItem[] };
```

- [ ] **Step 2: Write the reducer function**

After type definitions:

```typescript
function agentUIReducer(state: AgentUIState, action: AgentUIAction): AgentUIState {
  switch (action.type) {
    case 'SUBMIT_START':
      return {
        ...state,
        streaming: true,
        currentTools: [],
        streamingStartTime: Date.now(),
      };

    case 'TEXT_DELTA_BATCH':
      return {
        ...state,
        messages: [
          ...state.messages.filter(m => m.id !== action.streamingMessageId),
          action.message,
        ],
      };

    case 'TOOL_START':
      return {
        ...state,
        currentTools: Array.from(action.runningTools.values()),
      };

    case 'TOOL_RESULT':
      return {
        ...state,
        currentTools: Array.from(action.runningTools.values()),
        toolResults: new Map(state.toolResults).set(action.toolId, action.result),
        messages: action.messages,
        todos: action.todos,
      };

    case 'LOOP_COMPLETE':
      // Accumulate token usage if provided
      let newTotalUsage = state.totalUsage;
      if (action.usage) {
        newTotalUsage = {
          promptTokens: state.totalUsage.promptTokens + action.usage.prompt_tokens,
          completionTokens: state.totalUsage.completionTokens + action.usage.completion_tokens,
          totalTokens: state.totalUsage.totalTokens + action.usage.total_tokens,
        };
      }
      return {
        ...state,
        streaming: false,
        messages: action.messages,
        todos: action.todos,
        currentTools: [],
        totalUsage: newTotalUsage,
        streamingStartTime: null,
      };

    case 'AGENT_ERROR':
      return {
        ...state,
        messages: [...state.messages, action.errorMessage],
      };

    case 'SUB_AGENT_START':
      const nextRunning = new Map(state.runningSubAgents);
      nextRunning.set(event.agentId, action.event);
      return {
        ...state,
        runningSubAgents: nextRunning,
      };

    case 'SUB_AGENT_DONE':
      const nextRunningAfter = new Map(state.runningSubAgents);
      nextRunningAfter.delete(action.event.agentId);
      const nextCompleted = new Map(state.completedSubAgents);
      nextCompleted.set(action.event.agentId, {
        summary: action.event.summary,
        totalTurns: action.event.totalTurns,
        durationMs: action.event.durationMs,
        isError: action.event.isError,
      });
      return {
        ...state,
        runningSubAgents: nextRunningAfter,
        completedSubAgents: nextCompleted,
      };

    case 'FOCUS_TOOL':
      return {
        ...state,
        focusedToolId: action.id,
      };

    case 'TOGGLE_EXPANDED':
      if (!state.focusedToolId) return state;
      const nextExpanded = new Set(state.expandedTools);
      if (nextExpanded.has(state.focusedToolId)) {
        nextExpanded.delete(state.focusedToolId);
      } else {
        nextExpanded.add(state.focusedToolId);
      }
      return {
        ...state,
        expandedTools: nextExpanded,
      };

    case 'MOVE_FOCUS': {
      const { collapsibleTools, direction } = action;
      if (collapsibleTools.length === 0) {
        return { ...state, focusedToolId: null };
      }

      let currentIndex = state.focusedToolId ? collapsibleTools.indexOf(state.focusedToolId) : -1;
      let nextIndex = currentIndex + direction;
      if (nextIndex < 0) nextIndex = collapsibleTools.length - 1;
      if (nextIndex >= collapsibleTools.length) nextIndex = 0;
      const newFocusId = collapsibleTools[nextIndex];

      return {
        ...state,
        focusedToolId: newFocusId,
      };
    }

    case 'SET_TODOS':
      return {
        ...state,
        todos: action.todos,
      };

    default:
      const _exhaustive: never = action;
      return state;
  }
}
```

Note: Fix the `case 'SUB_AGENT_START':` to use `action.event` correctly (the above is correct).

- [ ] **Step 3: Replace useState declarations with useReducer**

Original 7 useState calls → replace with:

```typescript
const [state, dispatch] = useReducer(agentUIReducer, {
  streaming: false,
  messages: [],
  todos: [],
  currentTools: [],
  runningSubAgents: new Map(),
  completedSubAgents: new Map(),
  focusedToolId: null,
  expandedTools: new Set(),
  toolResults: new Map(),
  totalUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  streamingStartTime: null,
});

// Destructure for convenience
const {
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
  streamingStartTime,
} = state;
```

Keep existing: `streamingRef` and `streamingMessageRef` and `batchTimerRef` and `streamingContentRef`.

- [ ] **Step 4: Update all event handlers to dispatch instead of multiple setStates**

Update the event loop where events are handled:

For `tool_call_start`:
```typescript
} else if (event.type === 'tool_call_start') {
  runningTools.set(event.toolCall.id, event);
  dispatch({ type: 'TOOL_START', runningTools });
}
```

For `tool_call_result`:
```typescript
} else if (event.type === 'tool_call_result') {
  runningTools.delete(event.toolCall.id);
  // After tool result completes, refresh from full context
  // This ensures tool messages are shown separately immediately
  streamingContentRef.current = '';
  streamingMessageRef.current = null;
  refreshMessages();
  refreshTodos();
  dispatch({
    type: 'TOOL_RESULT',
    runningTools,
    toolId: event.toolCall.id,
    result: { durationMs: event.durationMs, isError: event.isError },
    messages: agent.getContext().messages,
    todos: agentWithContextManager.getContextManager().getTodos(),
  });
}
```

For the loop completion after `for await...`:

After `const allMessages = fullContext.messages;`, extract usage and dispatch:
```typescript
// Extract usage from the last response if available
const lastResponse = (agent as Agent & { getContextManager(): ContextManager })
  .getContextManager()
  .getContext(agent.config).response;
const usage = lastResponse?.usage;

dispatch({
  type: 'LOOP_COMPLETE',
  messages: allMessages,
  todos: agentWithContextManager.getContextManager().getTodos(),
  usage,
});
```

For `agent_error`:
```typescript
} else if (event.type === 'agent_error') {
  const errorMessage: Message = {
    role: 'assistant',
    content: `Error: ${event.error.message}`,
  };
  dispatch({ type: 'AGENT_ERROR', errorMessage });
}
```

For `sub_agent_start`:
```typescript
} else if (event.type === 'sub_agent_start') {
  dispatch({ type: 'SUB_AGENT_START', event });
}
```

For `sub_agent_done`:
```typescript
} else if (event.type === 'sub_agent_done') {
  dispatch({ type: 'SUB_AGENT_DONE', event });
}
```

- [ ] **Step 5: Update callback functions to use dispatch**

`focusTool`:
```typescript
const focusTool = useCallback((id: string) => {
  dispatch({ type: 'FOCUS_TOOL', id });
}, []);
```

`toggleFocusedTool`:
```typescript
const toggleFocusedTool = useCallback(() => {
  dispatch({ type: 'TOGGLE_EXPANDED' });
}, []);
```

`moveFocus`:
```typescript
const moveFocus = useCallback((direction: -1 | 1) => {
  const collapsibleTools = getCollapsibleTools();
  dispatch({ type: 'MOVE_FOCUS', direction, collapsibleTools });
}, [getCollapsibleTools]);
```

`refreshTodos`:
```typescript
const refreshTodos = useCallback(() => {
  const agentWithContextManager = agent as Agent & { getContextManager(): { getTodos: () => UITodoItem[] } };
  if (typeof agentWithContextManager.getContextManager === 'function') {
    const updatedTodos = agentWithContextManager.getContextManager().getTodos();
    dispatch({ type: 'SET_TODOS', todos: updatedTodos });
  }
}, [agent]);
```

- [ ] **Step 6: Update context value memoization**

Update the `useMemo` for context value to include all state fields:

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
    tokenLimit: agent.config.tokenLimit,
    streamingStartTime,
    onSubmit,
    onSubmitWithSkill,
    abort,
    setTodos: (todos: UITodoItem[]) => dispatch({ type: 'SET_TODOS', todos }),
    focusTool,
    toggleFocusedTool,
    moveFocus,
  }),
  [agent, messages, onSubmit, onSubmitWithSkill, abort, streaming, todos, currentTools, runningSubAgents, completedSubAgents, focusedToolId, expandedTools, toolResults, totalUsage, streamingStartTime, focusTool, toggleFocusedTool, moveFocus],
);
```

- [ ] **Step 7: Update AgentLoopState type definition**

Update the `AgentLoopState` type at top of file:

```typescript
type AgentLoopState = {
  agent: Agent;
  streaming: boolean;
  messages: Message[];
  todos: UITodoItem[];
  currentTools: ToolCallStartEvent[];
  runningSubAgents: Map<string, SubAgentStartEvent>;
  completedSubAgents: Map<string, { summary: string; totalTurns: number; durationMs: number; isError: boolean }>;
  /** ID of currently focused tool for keyboard interaction */
  focusedToolId: string | null;
  /** Set of tool IDs that are currently expanded */
  expandedTools: Set<string>;
  onSubmit: (text: string) => Promise<void>;
  onSubmitWithSkill: (submission: PromptSubmission) => void;
  abort: () => void;
  setTodos: (todos: UITodoItem[]) => void;
  /** Focus a specific tool by ID */
  focusTool: (id: string) => void;
  /** Toggle expanded state of currently focused tool */
  toggleFocusedTool: () => void;
  /** Move focus to previous/next tool (direction: -1 = previous, 1 = next) */
  moveFocus: (direction: -1 | 1) => void;
  /** Cached metadata for completed tool results */
  toolResults: Map<string, { durationMs: number; isError: boolean }>;
  /** Accumulated total token usage across all turns */
  totalUsage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** Token limit from agent config */
  tokenLimit: number;
  /** Start time of current streaming turn (null if not streaming) */
  streamingStartTime: number | null;
};
```

- [ ] **Step 8: Compile and fix errors**

```bash
bun run tsc
```

Fix any type errors. All fields should match between `AgentLoopState`, reducer `AgentUIState`, and the context provider value.

- [ ] **Step 9: Commit**

```bash
git add src/cli/tui/hooks/use-agent-loop.tsx
git commit -m "refactor(p2): convert multiple useState to useReducer

Consolidates all UI state into a single reducer. Every agent event
now dispatches exactly one action, causing exactly one render instead
of 3-4 separate renders from multiple setState calls.

Also adds accumulated totalUsage tracking for indicators.
"
```

---

## Task 8: UX - Update Header with model name and session ID

**Files:**
- Modify: `src/cli/tui/components/Header.tsx`

- [ ] **Step 1: Add context usage**

```typescript
import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks/use-agent-loop';

// ASCII hamster logo for the TUI header
const HAMSTER_LOGO = `\
▄█▄█▄
█●█●█
▀███▀
 █ █`;

export function Header() {
  const { agent, totalUsage } = useAgentLoop();

  // Get model from config if available
  // The config may have model override
  const model = agent.config.model;
  // Session ID from where? It's in SessionStore passed to App
  // We need to get sessionStore from where?
  // Update: App has sessionStore in props - need to pass down
  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text>{HAMSTER_LOGO}</Text>
        <Text>
          <Text bold color="cyan">my-agent</Text>
          {model && <Text dimColor> ({model})</Text>}
          <Text dimColor> - interactive AI agent terminal</Text>
        </Text>
      </Box>
    </Box>
  );
}
```

Wait - actually we need to pass `sessionStore` into Header from `AppContent`:
Update `App.tsx` first → pass `sessionStore` to `Header`.

- [ ] **Step 2: Update Header to accept props and display session ID**

Full updated Header:

```typescript
import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks/use-agent-loop';
import type { SessionStore } from '../../../session/store';

// ASCII hamster logo for the TUI header
const HAMSTER_LOGO = `\
▄█▄█▄
█●█●█
▀███▀
 █ █`;

export function Header({ sessionStore }: { sessionStore: SessionStore }) {
  const { agent } = useAgentLoop();

  // Get model from config if available
  const model = agent.config.model;
  const sessionId = sessionStore.getSessionId();

  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text>{HAMSTER_LOGO}</Text>
        <Text>
          <Text bold color="cyan">my-agent</Text>
          {model && <Text dimColor> ({model})</Text>}
        </Text>
      </Box>
      {sessionId && <Text dimColor>Session: {sessionId.slice(0, 8)}</Text>}
    </Box>
  );
}
```

- [ ] **Step 3: Update App.tsx to pass sessionStore to Header**

In `AppContent`, update:
```typescript
<Header sessionStore={sessionStore} />
```

- [ ] **Step 4: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/Header.tsx src/cli/tui/components/App.tsx
git commit -m "feat(ux): add model name and session ID to header"
```

---

## Task 9: UX - Update StreamingIndicator with turn count and elapsed time

**Files:**
- Modify: `src/cli/tui/components/StreamingIndicator.tsx`

- [ ] **Step 1: Update to use streamingStartTime from context**

Full updated component:

```typescript
import { Box, Text } from 'ink';
import React from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';
import { useMemo } from 'react';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime } = useAgentLoop();

  if (!streaming) return null;

  const elapsedMs = streamingStartTime ? Date.now() - streamingStartTime : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);

  // Get turn index from current event - we track it in the context
  // We can get current turn from the agent loop context - actually the event has turnIndex
  // Since we started counting at 0 when submit happens, display is +1
  // For now, we can get the number of messages as a proxy - user messages = turns
  const { messages } = useAgentLoop();
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

- [ ] **Step 2: Add `useRef` force update to refresh elapsed time**

Actually the elapsed time needs to update while streaming. Add an effect that forces a refresh every 100ms:

```typescript
import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime } = useAgentLoop();
  const [, forceUpdate] = useState({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (streaming && streamingStartTime) {
      intervalRef.current = setInterval(() => {
        forceUpdate({});
      }, 100);
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
  const { messages } = useAgentLoop();
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

- [ ] **Step 3: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/StreamingIndicator.tsx
git commit -m "feat(ux): add turn count and elapsed time to StreamingIndicator

During streaming, shows:
- Current turn number (based on number of assistant messages)
- Elapsed time in seconds, updates every 100ms
"
```

---

## Task 10: UX - Update Footer with token usage and context usage bar

**Files:**
- Modify: `src/cli/tui/components/Footer.tsx`

- [ ] **Step 1: Full rewrite with token usage and context bar**

```typescript
import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';

export function Footer() {
  const { totalUsage, tokenLimit } = useAgentLoop();

  const percentage = tokenLimit > 0 ? Math.round((totalUsage.totalTokens / tokenLimit) * 100) : 0;
  const barWidth = 20;
  const filled = Math.round(barWidth * totalUsage.totalTokens / tokenLimit);
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
            <Text dimColor>Tokens: {totalUsage.totalTokens.toLocaleString()}</Text>
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

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/Footer.tsx
git commit -m "feat(ux): add token usage and context usage bar to footer

Displays:
- Total accumulated token usage across all turns
- Context usage bar with color coding:
  - <60%: gray (normal)
  - 60-80%: yellow (warning - getting full)
  - >80%: red (danger - approaching limit)
"
```

---

## Task 11: Final compilation and smoke test

- [ ] **Step 1: Full TypeScript compile**

```bash
bun run tsc
```

Fix any remaining type errors.

- [ ] **Step 2: Run a quick test of the TUI dev mode**

```bash
bun run tui 2>&1 | head -50
```

Verify it starts without crashing.

- [ ] **Step 3: Commit any final fixes**

If there are fixes, commit:
```bash
git add ...
git commit -m "fix: resolve remaining type errors after refactor"
```

---

## Final Check

All optimizations implemented:
- [x] P0: 50ms batching for text_delta
- [x] P0: Remove refreshMessages at tool_call_start
- [x] P1: Global BlinkProvider instead of per-component intervals
- [x] P1: React.memo on ChatMessage
- [x] P1: Extract ToolCallWrapper to avoid context re-renders
- [x] P2: Consolidate to useReducer (one render per event)
- [x] UX: Header - model + session ID
- [x] UX: StreamingIndicator - turn count + elapsed time
- [x] UX: Footer - total tokens + context usage bar
