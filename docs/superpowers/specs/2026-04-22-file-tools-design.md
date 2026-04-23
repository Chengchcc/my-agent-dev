# File System Tools Design

## Overview

Add four specialized file system operation tools aligned with Claude Code's design philosophy:

| Tool | Purpose | Priority |
|------|---------|----------|
| `read` | Read file content with optional line range, smart truncation | P0 |
| `grep` | Search file content for text/regex patterns | P0 |
| `glob` | Find files by glob pattern | P1 |
| `ls` | List directory contents with metadata | P1 |

### Why This Is Valuable

1. **Security**: Better security than generic `bash` - explicit path restrictions, no arbitrary command execution
2. **Token Efficiency**: Structured output avoids spamming context with unnecessary content
3. **Usability**: LLM doesn't need to remember `find`/`grep` syntax - just call the semantic tool
4. **Observability**: Clean tool call display in TUI, exactly what file operation was performed
5. **Consistency**: Aligns with Claude Code's tool naming and parameter conventions

## Architecture

### Implementation Pattern

All new tools extend the existing `ZodTool` abstract base class:
- Zod schema for parameter definition
- Automatic conversion to JSON Schema
- Automatic validation before execution
- Consistent with other new tools in the codebase

### File Structure

```
src/tools/
├── index.ts          # Export all tools
├── glob.ts           # Glob tool implementation
├── grep.ts           # Grep tool implementation
├── ls.ts             # LS tool implementation
├── read.ts           # Read tool implementation
└── text-editor.ts    # Existing (unchanged except for TUI display)

src/cli/tui/components/
├── ReadFileView.tsx  # Read file content viewer with syntax highlighting
├── DiffView.tsx      # Diff viewer for after edits
└── utils/
    ├── language-map.ts    # Extension to language mapping
    └── tokenize-by-line.ts # Split Prism tokens by line
```

### Dependencies to Add

```json
{
  "dependencies": {
    "fast-glob": "^3.3.2",    // Fast glob pattern matching
    "diff": "^5.1.0"          // Diff calculation for after edits
  },
  "devDependencies": {
    "@types/diff": "^5.0.2"   // TypeScript types for diff
  }
}
```

## Tool Designs

### 1. `read` - Read File Content

**Purpose**: Read-only access to file content with line range support and smart truncation. Coexists with `text_editor` - `read` for exploration, `text_editor` for editing.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | File path to read |
| `start_line` | number | ❌ | Starting line number (1-indexed), default: 1 |
| `end_line` | number | ❌ | Ending line number (inclusive), default: end of file |
| `max_lines` | number | ❌ | Maximum lines to return, default: 500 |
| `encoding` | string | ❌ | File encoding, default: `utf-8` |

**Return Format**:

```typescript
{
  path: string;
  content: string;           // File content (with line numbers when full read)
  total_lines: number;       // Total lines in file
  range: {
    start: number;
    end: number;
  };
  truncated: boolean;        // Was output truncated by max_lines?
  size_bytes: number;        // File size in bytes
  language: string;          // Inferred language from extension
  diff?: {                   // Optional: diff after edit (str_replace/write)
    hunks: DiffHunk[];
  };
}
```

**Metadata-Only Mode**:
- When `max_lines: 0` is specified, returns only metadata without content
- Useful for LLM to decide whether reading the full file is worth the tokens

**Design Points**:

- Default `max_lines: 500` prevents accidental token overflow from large files
- Line numbers prefixed in output (e.g., `  42 │ content`) for easy reference in subsequent edits
- Automatic binary file detection - returns error instead of garbled content
- Security path validation reuse from `text_editor` - shares `allowedRoots` check

### 2. `grep` - Search File Content

**Purpose**: Search for text or regex patterns across files, similar to `ripgrep`.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Text or regex pattern to search for |
| `path` | string | ❌ | Base directory to search from, default: cwd |
| `include` | string | ❌ | Glob filter for file names (e.g., `*.ts`, `*.{ts,tsx}`) |
| `exclude` | string[] | ❌ | Patterns to exclude, default: `['node_modules', '.git', 'dist']` |
| `max_results` | number | ❌ | Maximum matching lines to return, default: 100 |
| `case_sensitive` | boolean | ❌ | Case sensitive search, default: false (smart case) |
| `is_regex` | boolean | ❌ | Is pattern a regular expression, default: false |
| `context_lines` | number | ❌ | Context lines before/after each match, default: 0 |

**Return Format**:

```typescript
{
  matches: Array<{
    file: string;
    line: number;
    content: string;
    context?: {
      before: string[];
      after: string[];
    };
  }>;
  truncated: boolean;
  total_matches: number;
  files_searched: number;
}
```

**Design Points**:

- **Smart Case**: Default case-insensitive, but automatically becomes case-sensitive if pattern contains uppercase letters (ripgrep style)
- **Hybrid Implementation**:
  - If `rg` (ripgrep) binary available in PATH: spawn it for speed
  - Fallback: pure Node.js recursive search with regex matching
- Default exclusion of common noise directories (`node_modules`, `.git`, `dist`, `build`)
- Output trimmed to control token consumption

### 3. `glob` - Find Files by Pattern

**Purpose**: Recursively find files matching a glob pattern.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `pattern` | string | ✅ | Glob pattern (e.g., `src/**/*.ts`, `**/package.json`) |
| `path` | string | ❌ | Base directory to search from, default: cwd |
| `exclude` | string[] | ❌ | Patterns to exclude, default: `['node_modules', '.git', 'dist']` |
| `max_results` | number | ❌ | Maximum results to return, default: 200 |
| `include_hidden` | boolean | ❌ | Include hidden files (starting with .), default: false |

**Return Format**:

```typescript
{
  files: string[];
  truncated: boolean;
  total_matched: number;
}
```

**Design Points**:

- Uses `fast-glob` library for efficient matching
- Directories sorted before files, then alphabetical by name
- Returns relative paths to keep output concise
- Default exclusion of common noise directories same as `grep`

### 4. `ls` - List Directory Contents

**Purpose**: List directory contents with file metadata.

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | ✅ | Directory path to list |
| `depth` | number | ❌ | Recursion depth, default: 1 (only direct children), max: 5 |
| `include_hidden` | boolean | ❌ | Include hidden files, default: false |
| `sort_by` | `name` \| `size` \| `modified` | ❌ | Sort order, default: `name` |

**Return Format**:

```typescript
{
  entries: Array<{
    name: string;
    type: 'file' | 'directory' | 'symlink';
    size?: number;
    modified?: string; // ISO 8601
    children_count?: number;
  }>;
  path: string; // Normalized absolute path
}
```

**Design Points**:

- When `depth > 1`, output can be formatted as a tree structure in TUI
- Directories always come before files
- Default exclusion of `node_modules`, `.git`, etc.
- Size information helps LLM decide whether to read a file

**Tree Output Option** (included):
When `depth > 1`, TUI can render an ASCII tree similar to the `tree` command:
```
src/
├── agent/
│   ├── Agent.ts
│   ├── context.ts
│   └── tool-registry.ts
├── cli/
│   └── tui/
│       ├── components/
│       └── hooks/
└── types.ts
```

## Security Design

All tools share the same security boundary:

| Measure | Implementation |
|---------|----------------|
| **Path Restriction** | All tools respect `allowedRoots` configuration (same as `text_editor`) |
| **Symlink Check** | Resolve symlinks and validate target is within `allowedRoots` |
| **Binary Files** | `read` detects and rejects binary files; `grep` automatically skips |
| **Size Limits** | `read` has `max_lines` hard limit; `grep` has `max_results` limit |
| **Sensitive Files** | Default exclusion pattern skips `.env`, `*.key`, `*credential*`, etc. |

## TUI Integration

### Components

Two new React components for displaying file content in the TUI:

#### `ReadFileView.tsx`

Renders file content with line numbers, gutter, and syntax highlighting:

```
── src/agent/Agent.ts (lines 42-68 of 350, typescript) ──
  42 │ async *run(messages: Message[]): AsyncGenerator<Chunk> {
  43 │   let turnIndex = 0;
  44 │   while (turnIndex <= this.config.maxTurns) {
  45 │     const tool_calls: ToolCall[] = [];
  ... │     ...
  68 │   }
```

**Props**:

```typescript
interface ReadFileViewProps {
  filePath: string;
  content: string;
  startLine: number;
  totalFileLines?: number;
  language?: string;
  maxHeight?: number;
  diff?: DiffInfo;
}
```

**Features**:
- Fixed-width gutter for line numbers (auto-sized based on max line number)
- Reuses existing Prism syntax highlighting from `CodeBlock`
- Vertical separator `│` between gutter and content
- Truncation with indicator when over `maxHeight`
- Language inferred from file extension

#### `DiffView.tsx`

Renders diff after edits with color coding:

```
── src/agent/Agent.ts (diff: +3 -1) ──
  42   async *run(messages: Message[]): AsyncGenerator<Chunk> {
  43     let turnIndex = 0;
  44 -   while (turnIndex < this.config.maxTurns) {
  44 +   while (turnIndex <= this.config.maxTurns) {
  45 +     const startTime = Date.now();
  46       const tool_calls: ToolCall[] = [];
  47       let content = '';
  48 +     let usage: Usage | undefined;
```

**Color Scheme**:

| Type | Gutter | Marker | Content |
|------|--------|--------|---------|
| Added | green | `+` | green text |
| Removed | red | `-` | red text + strikethrough |
| Context | dim | space | normal (syntax highlighted) |
| Hunk header | — | `@@` | cyan |

### Tool Format Extensions

Update `src/cli/tui/utils/tool-format.ts`:

**`formatToolCallTitle`**:
```typescript
case 'read':
  const range = args.start_line
    ? `lines ${args.start_line}-${args.end_line || 'end'}`
    : `${filePath}`;
  return `read(${JSON.stringify(filePath)}, ${range})`;

case 'grep':
  const pattern = truncate(String(args.pattern), 40);
  return `grep(${JSON.stringify(pattern)})`;

case 'glob':
  return `glob(${JSON.stringify(String(args.pattern))})`;

case 'ls':
  return `ls(${JSON.stringify(String(args.path))})`;
```

**`smartSummarize`**:
```typescript
case 'read': {
  const result = parsedResult;
  const lineRange = result.start === 1 && result.end === result.totalLines
    ? `${result.totalLines} lines`
    : `lines ${result.start}-${result.end} of ${result.totalLines}`;
  const diffTag = result.diff
    ? ` (${countAdded(result.diff)} added, ${countRemoved(result.diff)} removed)`
    : '';
  return `${result.path} — ${lineRange}${diffTag}`;
}

case 'grep': {
  const result = parsedResult;
  return `${result.matches.length} matches in ${result.files_searched} files`;
}

case 'glob': {
  const result = parsedResult;
  return `${result.files.length} files${result.truncated ? ' (truncated)' : ''}`;
}

case 'ls': {
  const result = parsedResult;
  return `${result.entries.length} entries`;
}
```

**Folding Behavior**:

| Content Size | Default State |
|--------------|---------------|
| ≤ 50 lines | Expanded |
| > 50 lines | Collapsed (shows summary, expand on Enter) |
| Diff | Always expanded |

### Utility Functions

**`language-map.ts`**: Maps file extensions to Prism language identifiers.

**`tokenize-by-line.ts`**: Splits Prism tokenized output into per-line arrays for individual line rendering.

### Reuse for `text_editor`

The `text_editor` `view` command also uses `ReadFileView` for consistent display.

## Diff Integration

After `text_editor` `str_replace` or `write` commands, the tool result can optionally include a diff of the changes. This diff is calculated in the tool implementation using the `diff` npm package, structured as hunks, and passed to `DiffView` for rendering.

**When Diff is Included**:

| Operation | Diff Included |
|-----------|---------------|
| `str_replace` | Always (before → after) |
| `write` to existing file | Always (old → new) |
| `write` to new file | No |
| `create` | No |

## Performance Considerations

| Concern | Strategy |
|---------|----------|
| Large file reading | `max_lines` truncation prevents token bloat |
| Large directory glob | `max_results` limits output size |
| Recursive grep | ripgrep is used when available for speed |
| React rendering | `maxHeight` caps rendered lines; `React.memo` caches components |
| Syntax highlighting | `useMemo` caches tokenization results |

## Implementation Order

1. Add dependencies (`fast-glob`, `diff`, `@types/diff`)
2. Implement `read` tool (P0)
3. Implement `grep` tool (P0)
4. Implement `glob` tool (P1)
5. Implement `ls` tool (P1)
6. Add `ReadFileView` TUI component
7. Add `DiffView` TUI component
8. Add utility functions (`language-map`, `tokenize-by-line`)
9. Update `tool-format.ts` for TUI display
10. Update `tools/index.ts` exports
11. Update TUI tool rendering to use new components

## Success Criteria

- All four tools work correctly from the agent
- LLM can use them to explore codebases effectively
- TUI displays them with proper formatting and syntax highlighting
- Diff after edits shows clearly
- Security boundaries work correctly
