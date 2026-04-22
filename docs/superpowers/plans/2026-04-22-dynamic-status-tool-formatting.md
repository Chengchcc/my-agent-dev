# Dynamic Status Indicators & Tool Result Formatting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add subtle blinking dynamic indicators for all in-processing states, improve todo item styling with strikethrough for completed tasks, and format tool object results as clean key-value tables instead of raw JSON.

**Architecture:** Incremental improvement to existing TUI components. Create one new reusable `BlinkingText` component, then update existing components to use it and add the requested styling/display improvements. All changes preserve existing functionality and follow the Minimalist Zen aesthetic.

**Tech Stack:** React + Ink (TypeScript), existing TUI component structure.

---

### Task 1: Create BlinkingText component

**Files:**
- Create: `src/cli/tui/components/BlinkingText.tsx`
- Modify: `src/cli/tui/components/index.ts`

- [ ] **Step 1: Create BlinkingText.tsx**

```tsx
import React, { useState } from 'react';
import { Text, useInterval } from 'ink';
import type { TextProps } from 'ink';

export interface BlinkingTextProps extends TextProps {
  /** Blink interval in milliseconds (default: 800 for slow/subtle blinking) */
  interval?: number;
}

export function BlinkingText({
  children,
  interval = 800,
  ...props
}: BlinkingTextProps) {
  const [visible, setVisible] = useState(true);

  useInterval(() => {
    setVisible(v => !v);
  }, interval);

  const opacity = visible ? 1 : 0.4;

  return (
    <Text {...props} opacity={opacity}>
      {children}
    </Text>
  );
}
```

- [ ] **Step 2: Add export to index.ts**

Add to `src/cli/tui/components/index.ts`:
```ts
export { BlinkingText } from './BlinkingText';
```

- [ ] **Step 3: Compile and verify**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/BlinkingText.tsx src/cli/tui/components/index.ts
git commit -m "feat(tui): add BlinkingText component with subtle slow blinking"
```

---

### Task 2: Add blinking to StreamingIndicator

**Files:**
- Modify: `src/cli/tui/components/StreamingIndicator.tsx`

- [ ] **Step 1: Read current file and update**

Import `BlinkingText` and wrap the "Thinking..." text:

Change from:
```tsx
import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming } = useAgentLoop();

  if (!streaming) return null;

  return (
    <Box>
      <Text color="gray">
        <Text dimColor>Thinking...</Text>
        {nextTodo && ` Next: ${nextTodo}`}
      </Text>
    </Box>
  );
}
```

To:
```tsx
import { Box, Text } from 'ink';
import React from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming } = useAgentLoop();

  if (!streaming) return null;

  return (
    <Box>
      <Text color="gray">
        <BlinkingText dimColor interval={800}>Thinking...</BlinkingText>
        {nextTodo && ` Next: ${nextTodo}`}
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/StreamingIndicator.tsx
git commit -m "feat(tui): add blinking to Thinking... indicator"
```

---

### Task 3: Add blinking to ToolCallMessage running status

**Files:**
- Modify: `src/cli/tui/components/ToolCallMessage.tsx`

- [ ] **Step 1: Add import and wrap "Running..." in BlinkingText**

Change from:
```tsx
import React from 'react';
import { Box, Text, Spacer } from 'ink';
import type { ToolCall } from '../../../types';
import type { ToolCallResultEvent } from '../../../agent/loop-types';
...
        {status === 'running' && <Text color="yellow">Running...</Text>}
```

To:
```tsx
import React from 'react';
import { Box, Text, Spacer } from 'ink';
import { BlinkingText } from './';
import type { ToolCall } from '../../../types';
import type { ToolCallResultEvent } from '../../../agent/loop-types';
...
        {status === 'running' && <BlinkingText color="yellow">Running...</BlinkingText>}
```

- [ ] **Step 2: Compile and verify**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/ToolCallMessage.tsx
git commit -m "feat(tui): add blinking to Running... tool status"
```

---

### Task 4: Improve TodoPanel styling (strikethrough completed + blink in-progress)

**Files:**
- Modify: `src/cli/tui/components/TodoPanel.tsx`

- [ ] **Step 1: Add imports**

```tsx
import { BlinkingText } from './';
```

- [ ] **Step 2: Update todo item rendering for completed status**

In the todo item row, add strikethrough and dimColor when status is 'completed':

```tsx
<Text
  {...(todo.status === 'completed' ? { strikethrough: true, dimColor: true } : {})}
>
  {todo.subject}
</Text>
```

- [ ] **Step 3: Wrap 'in_progress' status badge in BlinkingText**

When todo.status === 'in_progress', wrap the status indicator in `<BlinkingText color="blue">`.

Current status color logic already exists — just wrap the text output.

- [ ] **Step 4: Compile and verify**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/TodoPanel.tsx
git commit -m "feat(tui): strikethrough+diminish completed todos, blink in-progress status"
```

---

### Task 5: Add key-value table formatting for tool results

**Files:**
- Modify: `src/cli/tui/components/ToolCallMessage.tsx`

- [ ] **Step 1: Add helper function to render object/array as key-value table**

Add this inside the component file:

```tsx
function renderKeyValue(obj: unknown, indent: number = 0): React.ReactNode {
  if (typeof obj !== 'object' || obj === null) {
    return <Text dimColor>{String(obj)}</Text>;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return <Text dimColor>[]</Text>;
    }
    return (
      <Box flexDirection="column" paddingLeft={indent}>
        {obj.map((item, i) => (
          <Box key={i} flexDirection="row" gap={1}>
            <Text bold color="cyan">{i}:</Text>
            {renderKeyValue(item, indent + 1)}
          </Box>
        ))}
      </Box>
    );
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <Text dimColor>{}</Text>;
  }

  return (
    <Box flexDirection="column" paddingLeft={indent}>
      {entries.map(([key, value]) => (
        <Box key={key} flexDirection="row" gap={1}>
          <Text bold color="cyan">{key}:</Text>
          {renderKeyValue(value, indent + 1)}
        </Box>
      ))}
    </Box>
  );
}
```

- [ ] **Step 2: Update the result rendering section to use table formatting**

Change from:
```tsx
{result !== undefined && status !== 'running' && (
  <Box flexDirection="column" marginTop={1}>
    <Text bold>Output:</Text>
    <Text dimColor>
      {typeof result === 'string'
        ? result
        : JSON.stringify(result, null, 2)}
    </Text>
  </Box>
)}
```

To:
```tsx
{result !== undefined && status !== 'running' && (
  <Box flexDirection="column" marginTop={1}>
    <Text bold>Output:</Text>
    <Box paddingTop={0} paddingLeft={1}>
      {typeof result === 'string' ? (
        <Text dimColor>{result}</Text>
      ) : (
        renderKeyValue(result)
      )}
    </Box>
  </Box>
)}
```

- [ ] **Step 3: Verify error color is already red (already correct)**

Status 'error' already has `color="red"` - keep that.

- [ ] **Step 4: Compile and verify**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/components/ToolCallMessage.tsx
git commit -m "feat(tui): format tool object results as key-value tables instead of raw JSON"
```

---

### Task 6: Final compilation and verification

**Files:**
- None (test only)

- [ ] **Step 1: Full TypeScript compilation**

```bash
bun run tsc
```
Expected: No errors.

- [ ] **Step 2: Verify all components import correctly**

Check that:
- `BlinkingText` is exported from components index
- All importing components compile without errors
- All existing functionality is preserved

- [ ] **Step 3: Verify the existing truncation still works**

Truncation for large tool outputs happens at the ChatMessage level before ToolCallMessage is rendered - it should continue working as before.

- [ ] **Step 4: Final self-review**

## Self-Review

- **Spec coverage:** All requirements from the spec are covered:
  ✓ New reusable BlinkingText component with 800ms slow interval
  ✓ Blinking applied to all three processing locations: Thinking..., Running..., in-progress todo
  ✓ Completed todos have strikethrough + dimColor
  ✓ Tool object results formatted as key-value tables (strings still displayed as-is)
  ✓ Errors keep red color distinction
  ✓ All existing imports and exports updated
  ✓ TypeScript compilation checked

- **Placeholders:** No TBD or incomplete sections
- **Type consistency:** All imports and exports match, component props correctly typed
