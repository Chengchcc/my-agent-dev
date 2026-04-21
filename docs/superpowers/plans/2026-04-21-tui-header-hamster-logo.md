# TUI Header Hamster Logo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ASCII art hamster logo to the left side of the TUI header component.

**Architecture:** Modify the existing `Header.tsx` component to add the ASCII hamster logo positioned to the left of the existing title text using a horizontal flex layout. This is a minimal change that follows the existing component structure.

**Tech Stack:**
- React with Ink for terminal UI
- TypeScript
- Existing component structure

---

### Task 1: Update Header Component with Hamster Logo

**Files:**
- Modify: `src/cli/tui/components/Header.tsx`

- [ ] **Step 1: Update the Header component to add logo**

Modify the file to use horizontal flex layout and add the ASCII hamster:

```tsx
import { Box, Text } from 'ink';
import React from 'react';

export function Header() {
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Text>
        ▄█▄█▄{'\n'}
        █●█●█{'\n'}
        ▀███▀{'\n'}
         █ █
      </Text>
      <Text>
        <Text bold color="blue">my-agent</Text> - interactive AI agent terminal
      </Text>
    </Box>
  );
}
```

- [ ] **Step 2: Compile TypeScript to verify**

Run: `bun run tsc`
Expected: No compilation errors

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/Header.tsx
git commit -m "feat(tui): add hamster ASCII logo to header"
```

---

### Task 2: Verify Visual Layout

**Files:**
- Test run: `src/cli/tui/components/Header.tsx`

- [ ] **Step 1: Run the TUI in development to verify layout**

Run: `bun run tui`
Expected: Hamster logo displays on the left, text aligned properly, everything renders correctly in terminal.

