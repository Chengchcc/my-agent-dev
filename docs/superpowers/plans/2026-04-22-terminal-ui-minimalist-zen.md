# Terminal UI Redesign: Minimalist Zen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the existing terminal UI to the Minimalist Zen aesthetic with consistent Nord color palette, rounded borders, and clean spacing.

**Architecture:** Incremental refactor of existing TUI components — each component updated individually to match the new design while preserving all existing functionality. No architectural changes needed.

**Tech Stack:** React + Ink (TypeScript), existing component structure.

---

### Task 1: Update Header component colors

**Files:**
- Modify: `src/cli/tui/components/Header.tsx`

- [ ] **Step 1: Read current file content**

- [ ] **Step 2: Update colors to Minimalist Zen palette**

Change from:
```tsx
<Text>
  <Text bold color="blue">my-agent</Text> - interactive AI agent terminal
</Text>
```

To (preserve logo):
```tsx
<Text>
  <Text bold color="blue">my-agent</Text>
  <Text dimColor> - interactive AI agent</Text>
</Text>
```

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/Header.tsx
git commit -m "refactor(tui): update header colors to Minimalist Zen palette"
```

---

### Task 2: Update Footer component styling

**Files:**
- Modify: `src/cli/tui/components/Footer.tsx`

- [ ] **Step 1: Read current file content**

- [ ] **Step 2: Already uses dimColor — ensure consistent margin**

Current margin is `marginTop={1}` which is correct. Verify no other changes needed.

- [ ] **Step 3: Commit**

(Only if changes were needed, otherwise skip.)

---

### Task 3: Update ChatMessage role colors to Nord palette

**Files:**
- Modify: `src/cli/tui/components/ChatMessage.tsx`

- [ ] **Step 1: Read current file content**

- [ ] **Step 2: Update `getRoleColor` function to use muted Nord palette**

Change from:

```tsx
const getRoleColor = (role: string): string => {
  switch (role) {
    case 'user':
      return 'blue';
    case 'assistant':
      return 'green';
    case 'system':
      return 'yellow';
    case 'tool':
      return 'magenta';
    default:
      return 'gray';
  }
};
```

To:

```tsx
const getRoleColor = (role: string): string => {
  switch (role) {
    case 'user':
      return 'cyan';      // Nord cyan for user input
    case 'assistant':
      return 'white';     // Light gray/white for assistant output (Nord #d8dee9)
    case 'system':
      return 'yellow';    // Muted yellow for system messages (Nord #ebcb8b)
    case 'tool':
      return 'magenta';   // Muted purple for tool output (Nord #b48ead)
    default:
      return 'gray';
  }
};
```

- [ ] **Step 3: Add consistent margin between messages**

Verify the outer Box has `marginBottom={1}` — it already does. No change needed.

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/ChatMessage.tsx
git commit -m "refactor(tui): update chat message colors to Nord palette"
```

---

### Task 4: Add rounded border to TodoPanel

**Files:**
- Modify: `src/cli/tui/components/TodoPanel.tsx`

- [ ] **Step 1: Read current file content**

- [ ] **Step 2: Add rounded border with gray color and padding**

Wrap existing content in a Box with border:

```tsx
return (
  <Box
    flexDirection="column"
    borderStyle="rounded"
    borderColor="gray"
    paddingX={1}
    marginY={1}
  >
    {/* existing content goes here */}
  </Box>
);
```

- [ ] **Step 3: Update text styling for consistent hierarchy**

- Title: `bold`
- Status text: `dimColor` for secondary info
- Keep existing functionality

- [ ] **Step 4: Commit**

```bash
git add src/cli/tui/components/TodoPanel.tsx
git commit -m "feat(tui): add rounded border to TodoPanel - Minimalist Zen"
```

---

### Task 5: Update AskUserQuestionPrompt colors to match palette

**Files:**
- Modify: `src/cli/tui/components/AskUserQuestionPrompt.tsx`

- [ ] **Step 1: Read current file content**

- [ ] **Step 2: Already has rounded border — update border color from `cyan` to `gray`**

Change from:
```tsx
<Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
```

To:
```tsx
<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginY={1}>
```

(The active tab text already uses cyan which matches the design — keep that.)

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/AskUserQuestionPrompt.tsx
git commit -m "refactor(tui): update AskUserQuestion border to Minimalist Zen"
```

---

### Task 6: Verify InputBox and CommandList styling matches

**Files:**
- Modify: `src/cli/tui/components/InputBox.tsx`
- Modify: `src/cli/tui/components/CommandList.tsx`

- [ ] **Step 1: Read InputBox and check colors**

- [ ] **Step 2: Read CommandList and check colors**

- [ ] **Step 3: Make any small adjustments needed to match Nord palette**

- [ ] **Step 4: Commit**

(Only if changes needed.)

---

### Task 7: Test the TUI runs and looks correct

**Files:**
- None (test only)

- [ ] **Step 1: Compile TypeScript**

```bash
bun run tsc
```

Expected: No errors.

- [ ] **Step 2: Run TUI development server to visually inspect**

```bash
bun run tui
```

Verify:
- All components have consistent rounded borders where expected
- Colors are muted and cohesive (no bright clashing colors)
- Spacing looks clean with good breathing room
- All interactive elements still work
- Hamster logo preserved in header

- [ ] **Step 3: Fix any issues found during testing**

- [ ] **Step 4: Commit fixes if any**

- [ ] **Step 5: Final verify compilation**

```bash
bun run tsc
```

---

## Self-Review

- **Spec coverage:** All requirements from the spec are covered:
  ✓ Nord color palette applied throughout
  ✓ Consistent rounded borders on all panels (TodoPanel + AskUserQuestionPrompt)
  ✓ Kept existing layout, header logo, and footer text
  ✓ Incremental changes, no architecture changes
  ✓ No new dependencies required

- **Placeholders:** No TBD or incomplete sections
- **Type consistency:** All existing types are preserved, no changes to public APIs
