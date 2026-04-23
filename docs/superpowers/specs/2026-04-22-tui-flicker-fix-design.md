# TUI Flicker Optimization Fixes - Design Spec

## Overview

This spec covers fixing the issues identified after the initial TUI flicker optimization work. The original optimization added batching, reduced unnecessary re-renders, and introduced a global blink timer. This spec fixes the remaining bugs and performance issues.

## Issues and Fixes

### 1. P1: TOOL_START - Map reference instead of snapshot

**Problem:** In `use-agent-loop.tsx`, when dispatching `TOOL_START`, the code passes the existing `runningTools` Map by reference. Since the reducer may not execute synchronously (React 18 batching), if a subsequent `tool_call_result` mutates the Map before the reducer runs, the reducer will see the already-modified Map.

**Fix:** Create a snapshot when dispatching:
```typescript
dispatch({ type: 'TOOL_START', runningTools: new Map(runningTools) });
```

### 2. P1: LOOP_COMPLETE - only last turn usage accumulated

**Problem:** Currently, `usage` is extracted from `agent.getContext().response?.usage` after the loop completes, which only contains the usage from the *last* turn. All previous turns' usage is lost, so the accumulated total is incomplete.

**Fix:**
- Add `usage?: { prompt_tokens: number; ... }` field to `TurnCompleteEvent` in `loop-types.ts`
- In `Agent.runAgentLoop()`, after the model completes, yield the `turn_complete` event with the usage captured from the current turn
- In `use-agent-loop.tsx` reducer, handle `turn_complete` and accumulate usage immediately into `totalUsage`
- This ensures every turn's usage is captured

### 3. P1: Footer - context usage percentage dimension mismatch

**Problem:** The footer "Context" bar currently shows `totalUsage.totalTokens / tokenLimit`, where `totalUsage` is *cumulative* across all turns. But `tokenLimit` is the *per-context window* maximum. Cumulative tokens can vastly exceed the context window limit after multiple turns, making the percentage meaningless.

**Fix:**
- Add `@anthropic-ai/tokenizer` dependency for accurate Claude token counting
- In `AgentLoopProvider`, calculate `currentContextTokens` by counting tokens in the current messages array
- Add `currentContextTokens` to the context state
- Update `Footer` to display `currentContextTokens / tokenLimit` instead of cumulative usage
- Keep showing cumulative `totalTokens` as a separate display for informational purposes

### 4. P1: StreamingIndicator - 100ms forceUpdate causes unnecessary renders

**Problem:** `StreamingIndicator` currently forces a re-render every 100ms during streaming to update the elapsed time. This causes unnecessary re-renders of the entire parent chain.

**Fix:**
- Merge the two `useAgentLoop()` calls into one
- Reduce refresh frequency from 100ms → 500ms (elapsed time only needs single-digit second accuracy, so 2 updates per second is enough)
- `turnCount` will be tracked from the `turnIndex` in events rather than filtering messages on every render

### 5. P2: Header - model name usually undefined

**Problem:** Header currently reads `agent.config.model`, but `AgentConfig.model` is only an optional override for memory extraction. The actual model name is configured in the Provider's `LLMConfig`.

**Fix:**
- Add `getModelName(): string` method to the `Provider` interface in `types.ts`
- Implement `getModelName()` in both `ClaudeProvider` and `OpenAIProvider` to return the configured model name
- Add `getModelName(): string` method to the `Agent` class that delegates to the provider
- Update `Header` to use `agent.getModelName()` instead of `agent.config.model`

### 6. P2: ChatMessage - ToolCallWrapper memo penetration

**Problem:** `ChatMessage` is memoized with `React.memo`, but `ToolCallWrapper` inside it uses `useAgentLoop()` which subscribes to the entire context. When any context changes (e.g., `focusedToolId`), *all* `ToolCallWrapper` instances re-render, bypassing the `ChatMessage` memo.

**Fix:**
- Keep using `useAgentLoop` to get the full context
- Wrap the output in `React.useMemo` with dependencies only on the specific fields that affect *this tool*:
  - `toolCall.id`
  - `focusedToolId === toolCall.id`
  - `expandedTools.has(toolCall.id)`
  - `toolResults.has(toolCall.id)`
  - `currentTools.some(t => t.toolCall.id === toolCall.id)`
  - existence of the tool result message in `messages`
- This ensures `ToolCallWrapper` only re-renders when something about this specific tool changes.

### 7. P2: BlinkingText - interval prop unused

**Problem:** After migrating to `BlinkContext`, the `interval` prop on `BlinkingText` is no longer used but still appears in the interface, which is misleading.

**Fix:**
- Remove `interval` prop from `BlinkingTextProps` interface
- Remove `interval = 800` from the function parameters
- All blink interval control goes through `BlinkProvider` props, which is already where it's set in `App.tsx`

### 8. P2: StreamingIndicator - useAgentLoop called twice

**Problem:** `useAgentLoop()` is called twice - once at the top for `streaming` and `streamingStartTime`, then again later for `messages`. This is unnecessary, though not technically a bug since React hooks rules allow it (same order every render).

**Fix:**
- Merge into one call - destructure all needed values at once. This is already covered by #4.

## Decision Log

| Issue | Decision |
|-------|----------|
| Token estimation for context usage | Use `@anthropic-ai/tokenizer` for accurate counting |
| ToolCallWrapper re-render fix | Use `useMemo` with selective dependencies |
| Expose model name to Header | Add `getModelName()` to Provider interface |

## Dependencies

- Add `@anthropic-ai/tokenizer` as a dependency for accurate token counting

## Scope

This spec only covers bug fixes to the existing TUI flicker optimization code. No new features are added.
