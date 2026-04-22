# Tool Output Display Optimization Design

## Problem Statement

Current TUI tool output display has several issues:

1. **Lack of parameter visibility** — Only tool name is shown, users don't know what parameters were used
2. **Output flooding** — Long bash outputs (hundreds of lines) can completely fill the chat history
3. **Poor visual hierarchy** — Tool calls are mixed with assistant text in separate boxed messages
4. **No collapsibility** — All output is shown regardless of length

## Goals

Implement Claude Code-style tool display:
- One-line summary with parameter summary: `❯ bash("npx tsc --noEmit") 1523ms`
- Default folding for long outputs
- Smart summarization for common tools (tsc, text_editor, tests)
- Interactive expand/collapse via keyboard shortcuts (up/down focus, Ctrl+O toggle)
- Clear success/failure color coding

## Architecture

### 1. New Files

| File | Purpose |
|------|---------|
| `src/cli/tui/utils/tool-format.ts` | Formatting utilities: `formatToolCallTitle`, `smartSummarize`, `formatToolResult` |

### 2. Modified Files

| File | Changes |
|------|---------|
| `src/cli/tui/components/ToolCallMessage.tsx` | Complete rewrite with new props and styling |
| `src/cli/tui/components/ChatMessage.tsx` | Change rendering logic: don't render standalone `tool` messages, render `tool_calls` inline within `assistant` messages |
| `src/cli/tui/hooks/use-agent-loop.tsx` | Add `focusedToolId`, `expandedTools`, keyboard event handlers, focus navigation, toggle methods |
| `src/cli/tui/components/App.tsx` | Add Ink `useInput` listener for keyboard events |

## Data Structures

### Formatting Utilities

```typescript
// format one-line tool call title
function formatToolCallTitle(toolCall: ToolCall): string;

// Smart summarization for specific tool types (tsc, text_editor, test runners)
// Returns null if no special summary applies
function smartSummarize(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): string | null;

// Format result display based on length and expanded state
function formatToolResult(
  result: string,
  isError: boolean,
  expanded: boolean
): { display: string; raw: string; isCollapsible: boolean };
```

`isCollapsible` = output longer than 3 lines when not error. Only collapsible tools are included in keyboard navigation.

### AgentLoopState Additions

```typescript
type AgentLoopState = {
  // ... existing fields
  /** ID of currently focused tool for keyboard interaction */
  focusedToolId: string | null;
  /** Set of tool IDs that are currently expanded */
  expandedTools: Set<string>;
  /** Focus a specific tool by ID */
  focusTool: (id: string) => void;
  /** Toggle expanded state of currently focused tool */
  toggleFocusedTool: () => void;
  /** Move focus to previous/next tool */
  moveFocus: (direction: -1 | 1) => void;
};
```

### ToolCallMessage Props

```typescript
type ToolCallMessageProps = {
  toolCall: ToolCall;
  result?: {
    content: string;
    isError: boolean;
    durationMs: number;
  };
  pending: boolean;
  focused: boolean;
  expanded: boolean;
};
```

## Formatting Rules

### Parameter Summary

| Tool | Format | Example |
|------|--------|---------|
| `bash` | Truncate command to 80 chars | `bash("npx tsc --noEmit")` |
| `text_editor` | Sub-command + path | `text_editor(str_replace, "src/agent.ts")` |
| `sub_agent` | Truncate task to 60 chars | `sub_agent("Fix compilation errors...")` |
| Other | First 2 args | `memory(search, "test framework")` |

### Result Display Logic

| Condition | Display |
|-----------|---------|
| **pending** | Only title line, spinner |
| **isError** | Show first 10 lines, always (errors should be visible) |
| **!expanded, lines ≤ 3** | Full content inline |
| **!expanded, 3 < lines ≤ 20** | First 10 lines + `... (N lines)` |
| **!expanded, lines > 20** | First 5 lines + `... (N more lines)` + last 3 lines |
| **expanded** | Full content |

### Smart Summaries

| Tool / Command | Summary |
|----------------|---------|
| `bash` + `tsc` empty output | `✓ No errors` |
| `bash` + `tsc` with errors | `✗ N errors` |
| `bash` + `vitest`/`jest` | `✗ 2 failed, 12 passed` / `✓ 14 passed` |
| `text_editor view` | `(N lines)` |
| `text_editor create` | `✓ Created (N lines)` |
| `text_editor str_replace` | `✓ Replaced` |
| empty output | `(no output)` |

## Keyboard Interaction

| Shortcut | Action |
|----------|--------|
| **Up/Down arrows** | Cycle focus through collapsible tools |
| **Ctrl+O** | Toggle expand/collapse for focused tool |

- Only tools that are collapsible (output > 3 lines and not an error) are included in focus cycle
- Focus is maintained when new tools complete
- When no tool is focused, up/down starts from last completed tool

## Visual Style

| State | Border | Title | Result |
|-------|--------|-------|--------|
| Pending | None | Yellow ❯ prefix | - |
| Completed, not focused | None | Cyan title, gray duration | Gray text |
| Completed, focused | Blue (Nord #81a1c1) single border | Cyan title, gray duration | Gray text |
| Error | Red border (when focused) | Red ❯ prefix | Red text |

## Example Output

```
> user:
帮我看看项目能不能编译

< assistant:
让我检查一下。

  ❯ bash("npx tsc --noEmit")                              1523ms
    ✗ 4 errors
    src/agent.ts(45,3): error TS2345: Argument of type ...
    src/agent.ts(78,12): error TS2339: Property 'foo' ...
    src/types.ts(12,1): error TS1005: ';' expected.
    src/cli/tui/components/App.tsx(23,5): error TS2741: ...

有 4 个类型错误，让我逐个修复。

  ❯ text_editor(str_replace, "src/agent.ts")                  3ms
    ✓ Replaced
  ❯ text_editor(str_replace, "src/agent.ts")                  2ms
    ✓ Replaced
  ❯ text_editor(str_replace, "src/types.ts")                  2ms
    ✓ Replaced
  ❯ text_editor(str_replace, "src/cli/tui/components/App.tsx") 3ms
    ✓ Replaced

  ❯ bash("npx tsc --noEmit")                               982ms
    ✓ No errors

全部修复完成，编译通过。
```

## Trade-offs Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Expand/collapse state location | Global in AgentLoopProvider | Already need global focus management, consistent state |
| Focus traversal scope | Only collapsible tools | Avoid focusing tools that are already fully displayed |
| Highlight color | Nord blue | Less prominent than cyan, good balance |
| Message rendering | Inline in assistant message | Natural thought-action flow, matches Claude Code UX |

## Success Criteria

1. Tool calls display with parameter summaries on one line
2. Long outputs are collapsed by default
3. Users can navigate tools with up/down arrows
4. Users can toggle expanded state with Ctrl+O
5. Common tool types get smart summaries
6. Errors are clearly highlighted in red
7. Existing functionality (streaming, markdown, commands) continues to work
