---
date: 2026-04-22
topic: Dynamic Status Indicators + Tool Result Formatting + Todo Styling Improvements
author: Claude
status: approved
---

# Dynamic Status Indicators & Tool Display Improvements

## Overview

Add subtle blinking dynamic indicators for all "in processing" states, improve todo item styling with strikethrough for completed tasks, and optimize tool result display by formatting JSON objects into clean key-value tables instead of raw JSON blocks.

This builds on the existing Minimalist Zen aesthetic we just applied to the TUI.

## Requirements

### 1. Reusable Blinking Text Component

Create a new `BlinkingText` component that:

- Animates opacity between `1.0` (fully visible) and `0.4` (dimmed)
- Slow 800ms interval (subtle, not distracting)
- Accepts all standard Text props (color, bold, etc.)
- Children can be any React content
- Follows Minimalist Zen - subtle animation that doesn't disrupt focus

### 2. Blinking Applied to All Processing States

| Location | What gets blinking |
|----------|-------------------|
| `StreamingIndicator.tsx` | The "Thinking..." text when agent is streaming a response |
| `ToolCallMessage.tsx` | The "Running..." status badge when a tool is executing |
| `TodoPanel.tsx` | The status badge for "in_progress" todo items |

### 3. Todo Panel Styling Improvements

- **Completed items**: Add `strikethrough` text decoration AND `dimColor` to visually de-emphasize
- **In-progress items**: Add blinking indicator to the status badge to show active work
- **Pending items**: Keep current styling
- **Cancelled**: Already dim, keep current styling

### 4. Tool Result Display Optimization

- **Raw JSON → Key-value table**: When tool result is an object/array, format it as a clean vertical key-value table instead of raw JSON
- **Strings**: Display as-is (no change)
- **Errors**: Keep (and ensure) red colored text for clear distinction
- **Arguments**: Keep existing pretty-printed JSON - only optimize the **result/output** section
- **Truncation**: Still apply existing length limits (MAX_TOOL_LINES / MAX_TOOL_CHARS)

## Component Changes

### New Files

- `src/cli/tui/components/BlinkingText.tsx` — New reusable blinking text component

### Modified Files

- `src/cli/tui/components/StreamingIndicator.tsx` — Wrap "Thinking..." in BlinkingText
- `src/cli/tui/components/ToolCallMessage.tsx` — Wrap "Running..." in BlinkingText, add table formatting for object results
- `src/cli/tui/components/TodoPanel.tsx` — Add strikethrough/dimColor to completed, blink in-progress status
- `src/cli/tui/components/index.ts` — Export the new BlinkingText component

## Design Details

### Blinking Implementation

Use Ink's `useInterval` (or React `useEffect` + `setInterval`) with React state to track blink visibility:

```tsx
const [visible, setVisible] = useState(true);
useInterval(() => setVisible(v => !v), 800);
const opacity = visible ? 1 : 0.4;
```

Return `<Text opacity={opacity} {...props}>{children}</Text>;`

### Table Formatting for Objects

For object results:

```
Result:
  keyName:  value
  otherKey: [array, items]
```

Use `Box flexDirection="column"` with one row per key-value pair. Indent keys for clean visual hierarchy.

### Color Scheme (consistent with Minimalist Zen):

- Blinking: Preserves existing colors (just toggles opacity)
- Completed todos: dimColor + strikethrough (text color unchanged but de-emphasized)
- Errors: Keep red text color as before (good contrast)
- Table keys: bold cyan for labels, values: default color

## Success Criteria

1. All processing states have subtle slow blinking indicators that don't distract
2. Completed todos are visually distinct with strikethrough + dim
3. Tool object results are easier to read than raw JSON blocks
4. All existing functionality preserved (streaming, tool calls, todos)
5. TypeScript compiles without errors
6. Blinking animation works correctly in Ink/React
7. Consistent with Minimalist Zen aesthetic (subtle, clean, not overdone)

## Non-Goals

- No heavy animations or effects that would impact performance
- Changing the overall layout structure
- Adding new interactive features beyond what's specified
- Full JSON editor or collapsible sections
