# TUI Flicker Optimization and Indicator Enhancement Design

## Problem Statement

The TUI (Terminal UI) experiences visible flickering during streaming and tool execution caused by excessive React re-renders:

1. Every `text_delta` chunk triggers `setMessages` → full re-render (every 50-100ms)
2. `tool_call_start` / `tool_call_result` trigger multiple separate `setState` calls
3. `refreshMessages()` on `tool_call_start` causes streaming message ↔ context message switching flicker
4. Each `BlinkingText` has its own `setInterval` causing frequent independent state updates
5. Every `ChatMessage` consumes full `AgentLoopContext`, so any context change causes all messages to re-render
6. `ChatMessage` does O(n) `find()` on every render to look up tool results

Additionally, the TUI lacks useful status indicators that help users understand what's happening: token usage, turn count, elapsed time, context usage, model name.

## Goals

- Eliminate or drastically reduce visible flickering
- Maintain the existing functionality and interaction model
- Add useful status indicators to improve UX
- Keep the changes incremental and testable

## Implementation Plan (P0 → P1 → P2 order)

### P0: Highest Priority Fixes

#### 1. Batch text_delta updates to 50ms intervals

**Change**: Accumulate streaming content in a ref, only update `setMessages` at most once every 50ms using `setTimeout`.

**File**: `src/cli/tui/hooks/use-agent-loop.tsx`

**Effect**: Reduces render frequency from ~10-20 per second to max 20fps, eliminating most flicker from streaming.

**Code approach**:
```typescript
const streamingContentRef = useRef('');
const batchTimerRef = useRef<NodeJS.Timeout | null>(null);

// In text_delta handler:
streamingContentRef.current += event.delta;
if (!batchTimerRef.current) {
  batchTimerRef.current = setTimeout(() => {
    batchTimerRef.current = null;
    const streamingMessage = { id: streamingMessageId, ... };
    setMessages(prev => {
      const base = prev.filter(m => m.id !== streamingMessageId);
      return [...base, streamingMessage];
    });
  }, 50);
}
```

#### 2. Remove `refreshMessages()` call from `tool_call_start`

**Change**: Only call `refreshMessages()` at `tool_call_result`, not at start. This eliminates the flicker caused by switching between streaming message and context message.

**File**: `src/cli/tui/hooks/use-agent-loop.tsx`

**Effect**: Streaming continues smoothly during tool execution, no visible "blink" when a tool starts.

---

### P1: Next Priority Optimizations

#### 3. Global `BlinkProvider` for `BlinkingText`

**Change**: Replace per-component `setInterval` with a single context provider that drives all blinking from one timer.

**Files**:
- Create `src/cli/tui/components/BlinkContext.tsx`
- Modify `src/cli/tui/components/BlinkingText.tsx` to consume context

**Effect**: Only one state update every 800ms regardless of how many pending tools, instead of N intervals for N tools.

**Architecture**:
```typescript
const BlinkContext = createContext(true);

export function BlinkProvider({ children, interval = 8000 }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setVisible(v => !v), interval);
    return () => clearInterval(id);
  }, [interval]);
  return <BlinkContext.Provider value={visible}>{children}</BlinkContext.Provider>;
}

export function BlinkingText(props) {
  const visible = useContext(BlinkContext);
  return <Text {...props} dimColor={!visible}>{children}</Text>;
}
```

Then wrap app with `<BlinkProvider>` in `App.tsx`.

#### 4. `ChatMessage` with `React.memo`

**Change**: Wrap `ChatMessage` with `React.memo` and custom comparator to only re-render when its own content changes.

**File**: `src/cli/tui/components/ChatMessage.tsx`

**Effect**: History messages don't re-render when new messages are added or streaming progresses.

#### 5. Move `useAgentLoop` from `ChatMessage` to `ToolCallWrapper`

**Change**: Extract tool call rendering into an inner `ToolCallWrapper` that consumes the context, so `ChatMessage` itself doesn't depend on context. Prevents all `ChatMessage`s from re-rendering when focus/expansion state changes.

**File**: `src/cli/tui/components/ChatMessage.tsx`

**Effect**: Complements `React.memo` - only the affected `ToolCallWrapper` re-renders when focus changes, not all messages.

---

### P2: Deeper Optimization

#### 6. Replace multiple `useState` with `useReducer`

**Change**: Consolidate all UI state in `AgentLoopProvider` into a single `useReducer`. Each event dispatches a single action → one state update → one render.

**File**: `src/cli/tui/hooks/use-agent-loop.tsx`

**Effect**: Eliminates multiple renders per event that were caused by sequential `setState` calls (one event → 3-4 state updates → 3-4 renders).

**State shape**:
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
};
```

**Actions include**:
- `SUBMIT_START` - beginning of user submission
- `TEXT_DELTA_BATCH` - batched streaming update
- `TOOL_START` - tool started execution
- `TOOL_RESULT` - tool completed
- `LOOP_COMPLETE` - agent loop done
- `FOCUS_TOOL` - change focused tool
- `TOGGLE_EXPANDED` - toggle expanded tool
- `MOVE_FOCUS` - move focus up/down
- `ERROR` - agent error occurred

---

### UX: Indicator Additions

#### 7. Header: Model name + Session ID

**Change**: Update `Header` component to display current model name (from last response) and truncated session ID from `SessionStore`.

**File**: `src/cli/tui/components/Header.tsx`

**Display**:
```
hamster logo  my-agent (claude-3-5-sonnet-20241022)   Session: a1b2c3d4
```

#### 8. StreamingIndicator: Turn count + Elapsed time

**Change**: Update `StreamingIndicator` to show current turn index (1-based) and elapsed time in seconds since streaming started.

**File**: `src/cli/tui/components/StreamingIndicator.tsx`

**Display**:
```
⠋ Thinking...  Turn 1  2.3s
```

Tracking elapsed requires storing the start time in a ref when streaming starts.

#### 9. Footer: Token usage + Context usage bar

**Change**: Update `Footer` to display:
- Total token usage (cumulative from all responses)
- Context usage bar (used tokens / max tokens) with color coding:
  - <60%: default (gray)
  - 60-80%: yellow
  - >80%: red

**File**: `src/cli/tui/components/Footer.tsx`

**Token usage accumulation**:
- Agent already reports usage per response in `resultContext.response.usage`
- `AgentLoopProvider` accumulates total usage across all turns
- Total tokens displayed in footer

**Display**:
```
Type /exit to quit, /clear to clear conversation   Tokens: 12,450   Context: [███░░░░░░░░░░░] 25%
```

## File Changes Summary

| File | Change Type |
|------|-------------|
| `src/cli/tui/hooks/use-agent-loop.tsx` | Add batching, remove refresh, convert to useReducer |
| `src/cli/tui/components/BlinkingText.tsx` | Switch to context-based blinking |
| `src/cli/tui/components/BlinkContext.tsx` | New - provider for global blinking |
| `src/cli/tui/components/ChatMessage.tsx` | Add React.memo, extract ToolCallWrapper, remove direct context use |
| `src/cli/tui/components/App.tsx` | Add BlinkProvider wrapping |
| `src/cli/tui/components/Header.tsx` | Add model + session ID display |
| `src/cli/tui/components/StreamingIndicator.tsx` | Add turn count + elapsed time |
| `src/cli/tui/components/Footer.tsx` | Add token usage + context bar |
| `src/cli/tui/types.ts` | Add UITodoImport if needed |

## Success Criteria

1. No visible flickering during streaming - content updates smoothly
2. Multiple pending tools don't cause excessive rendering due to blinking
3. History messages don't re-render when streaming or focus changes
4. All indicators display correctly:
   - Header shows model + session
   - Streaming indicator shows turn + elapsed time
   - Footer shows cumulative tokens + context usage
5. All existing keyboard interactions still work (focus, expand, etc.)
6. TypeScript compiles successfully
