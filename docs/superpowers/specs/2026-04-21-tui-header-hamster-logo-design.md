# TUI Header Hamster Logo Design

## Overview
Add an ASCII art hamster logo to the TUI header on the left side of the title text.

## Context
The current `Header.tsx` component only contains text "my-agent - interactive AI agent terminal" with no logo. Adding a cute hamster logo improves the visual appeal of the terminal UI.

## Design Decision

### Placement
- Logo placed **to the left** of the existing title text
- Horizontal layout with logo + text side-by-side

### ASCII Art
Selected 4-line compact block-style hamster:
```
▄█▄█▄
█●█●█
▀███▀
 █ █
```

This design:
- Compact 4-line footprint
- Uses block characters and dots for a clear hamster face
- Fits well with terminal UI aesthetic
- Doesn't dominate the header

### Component Structure
- Keep existing `Header` component
- Add the ASCII art as a `<Text>` element
- Use `<Box flexDirection="row">` to arrange logo and text horizontally
- Add a small gap (`gap={1}`) between logo and text

## Changes
- File: `/src/cli/tui/components/Header.tsx`
- Only changes to this one file
- No breaking changes to existing props or structure

## Success Criteria
- Logo displays correctly in Ink/React terminal UI
- Horizontal layout aligns properly
- Existing text remains readable and correctly styled
