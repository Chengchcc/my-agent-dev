---
date: 2026-04-22
topic: Terminal UI Redesign - Minimalist Zen
author: Claude
status: approved
---

# Terminal UI Redesign: Minimalist Zen

## Overview

Redesign the existing Ink-based terminal UI using the **Minimalist Zen** aesthetic from the `ingpoc-skills-terminal-ui-design` skill. The goal is a clean, focused developer experience with consistent visual language and intentional spacing.

## Design Aesthetic

### Style: Minimalist Zen
- **Vibe**: Clean, focused, unobtrusive — stays out of the developer's way
- **Colors**: Nord palette cool blues/grays
- **Borders**: Rounded `╭─╮` with subtle gray tones
- **Spacing**: Generous whitespace for breathing room

## Color Palette

Following the Nord color scheme (adapted for Ink):

| Role | Hex (dark bg) | Ink color name | Purpose |
|------|---------------|----------------|---------|
| Background | `#2e3440` | Terminal default | Main background |
| Text Primary | `#d8dee9` | `gray` (bright) | Main message text |
| Text Secondary | `#4c566a` | `gray` (dim) | Secondary info, hints, footers |
| Accent Blue | `#5e81ac` | `blue` | Primary accents, focus, header |
| Accent Cyan | `#88c0d0` | `cyan` | Selections, interactive elements |
| User Messages | `#88c0d0` | `cyan` | User input |
| Assistant Messages | `#d8dee9` | `white` | Assistant output |
| System Messages | `#ebcb8b` | `yellow` | System notices (muted warm yellow) |
| Tool Messages | `#b48ead` | `magenta` | Tool outputs (muted purple) |
| Border | `#4c566a` | `gray` | Panel borders |
| Border Focus | `#5e81ac` | `blue` | Focused panel borders |

## Border and Typography Rules

- **Borders**: All floating panels (TodoPanel, AskUserQuestionPrompt) use consistent `rounded` border style
- **Typography**:
  - Only `bold` for emphasis (headings, labels)
  - `dimColor` for all secondary/hint text
  - No excessive decoration — underlines/italics only when semantically necessary
  - Unicode symbols sparingly for custom bullets/icons

## Layout

Keep existing structure:

```
┌─────────────────────────────────────────┐
│ Header (logo + name)                     │
├─────────────────────────────────────────┤
│                                         │
│  Scrollable Chat Area                    │
│  - Messages with role indicators        │
│  - Todo panel when active               │
│                                         │
├─────────────────────────────────────────┤
│  AskUserQuestion (when active)          │
│  Streaming indicator (when streaming)    │
│  Input box (when idle)                   │
├─────────────────────────────────────────┤
│  Footer (help text)                      │
└─────────────────────────────────────────┘
```

**Spacing improvements:**
- Consistent padding on all panels (1px horizontal, 1px vertical)
- Increased margin between messages for better separation
- Generous whitespace around interactive elements

## Component Changes

### Header (`Header.tsx`)
- Keep existing hamster ASCII logo
- Dim secondary text, blue for app name
- No border — clean top edge

### Footer (`Footer.tsx`)
- Keep existing help text
- Full dimColor treatment

### ChatMessage (`ChatMessage.tsx`)
- Muted role colors from Nord palette
- Consistent spacing
- Keep markdown rendering and truncation behavior

### TodoPanel (`TodoPanel.tsx`)
- Add rounded border with muted gray
- Consistent padding
- Clean hierarchical styling (bold for title, dim for status)

### AskUserQuestionPrompt (`AskUserQuestionPrompt.tsx`)
- Already uses rounded border — keep, just update colors to match Nord palette

### InputBox (`InputBox.tsx`)
- Refine colors to match accent
- Keep autocomplete dropdown styling consistent

## Dependencies

- No new dependencies needed
- Already using Ink's built-in `borderStyle` prop which supports `rounded`
- Existing React/Ink architecture remains unchanged

## Success Criteria

1. All components follow Minimalist Zen aesthetic consistently
2. All existing functionality preserved (chat, tool calls, questions, todos)
3. No visual regressions — layout works in standard 80x24 terminal
4. Cohesive Nord color palette applied throughout
5. All panels that need borders have consistent rounded styling

## Non-Goals

- Changing the fundamental component architecture
- Adding new interactive features
- Full dark/light theme switcher
- Animation effects (keep it minimal)
