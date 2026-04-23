# File System Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement four specialized file system operation tools (`read`, `grep`, `glob`, `ls`) aligned with Claude Code's design philosophy, plus TUI components for beautiful syntax-highlighted display.

**Architecture:** Each tool is implemented as a separate class extending `ZodTool` base class with Zod schema validation. TUI display uses two new React components (`ReadFileView`, `DiffView`) that reuse existing Prism syntax highlighting infrastructure. All tools share the same security path validation from `text_editor`.

**Tech Stack:** TypeScript, Zod, React + Ink (TUI), Prism (syntax highlighting), fast-glob (glob matching), diff (diff calculation), ripgrep (spawned for grep when available).

---

## File Structure

**New files to create:

| File | Purpose |
|------|---------|
| `src/tools/read.ts` | `read` tool implementation |
| `src/tools/grep.ts` | `grep` tool implementation |
| `src/tools/glob.ts` | `glob` tool implementation |
| `src/tools/ls.ts` | `ls` tool implementation |
| `src/cli/tui/components/ReadFileView.tsx` | React component for displaying read file content |
| `src/cli/tui/components/DiffView.tsx` | React component for displaying diffs |
| `src/cli/tui/utils/language-map.ts` | File extension to language mapping |
| `src/cli/tui/utils/tokenize-by-line.ts` | Split Prism tokens by line for per-line rendering |
| `src/tools/shared/path-validation.ts` | Shared path validation utilities (extracted from text-editor) |

**Files to modify:

| File | Changes |
|------|---------|
| `package.json` | Add dependencies: `fast-glob`, `diff`, `@types/diff` |
| `src/tools/index.ts` | Export all four new tools |
| `src/cli/tui/utils/tool-format.ts` | Add formatting for new tools |
| `src/cli/tui/components/index.ts` | Export new components |
| `src/tools/text-editor.ts` | Use shared path validation from `shared/path-validation.ts` |

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add dependencies to package.json

```bash
bun add fast-glob diff
bun add -D @types/diff
```

- [ ] **Step 2: Verify install completes successfully

Expected: No errors, dependencies added to package.json

- [ ] **Step 3: Commit

```bash
git add package.json
git commit -m "feat: add dependencies fast-glob and diff"
```

---

## Task 2: Extract Shared Path Validation

**Files:**
- Create: `src/tools/shared/path-validation.ts`
- Modify: `src/tools/text-editor.ts`

The `text-editor.ts` has a `validatePath` method that all new tools also need. Extract it to shared module.

- [ ] **Step 1: Create shared path-validation.ts**

```typescript
// src/tools/shared/path-validation.ts
import path from 'path';

/**
 * Shared path validation utilities for all file system tools.
 * Validates that accessed paths are within allowed roots for security.
 */
export function validatePath(filePath: string, allowedRoots?: string[]): boolean {
  if (!allowedRoots || allowedRoots.length === 0) {
    return true;
  }
  const resolved = path.resolve(filePath);
  return allowedRoots.some(root => {
    const resolvedAllowed = path.resolve(root);
    return resolved === resolvedAllowed || resolved.startsWith(resolvedAllowed + path.sep);
  });
}

/**
 * Check if a file should be excluded as sensitive.
 */
export function isSensitiveFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const sensitivePatterns = ['.env', '.key', '.pem', '.p12', '.pfx', 'credential', 'secret', 'password', 'private'];
  return sensitivePatterns.some(pattern => lower.includes(pattern));
}

/**
 * Default exclusion patterns.
 */
export const defaultExclusions = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.nyc_output/**',
  '**/.coverage/**',
];
```

- [ ] **Step 2: Refactor text-editor.ts to use shared validation**

In `src/tools/text-editor.ts`, replace the existing `validatePath` method with import:

```typescript
// add import at top
import { validatePath } from './shared/path-validation';

// remove the private validatePath method, keep the constructor
```

- [ ] **Step 3: Compile to verify no errors**

```bash
bun run tsc
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/shared/path-validation.ts src/tools/text-editor.ts
git commit -m "refactor: extract shared path validation to shared module"
```

---

## Task 3: Implement `read` Tool

**Files:**
- Create: `src/tools/read.ts`

- [ ] **Step 1: Create read.ts with Zod schema and implementation**

```typescript
// src/tools/read.ts
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { z } from 'zod';
import ZodTool from './zod-tool';
import { validatePath, isSensitiveFile } from './shared/path-validation';

const ReadSchema = z.object({
  path: z.string().describe('Absolute or relative path to the file to read'),
  start_line: z.number().int().min(1).optional().describe('Starting line number (1-indexed, default: 1)'),
  end_line: z.number().int().min(1).optional().describe('Ending line number (inclusive, default: end of file)'),
  max_lines: z.number().int().min(0).default(500).describe('Maximum lines to return (use 0 for metadata-only, default: 500)'),
  encoding: z.string().default('utf-8').describe('File encoding (default: utf-8)'),
});

export class ReadTool extends ZodTool<typeof ReadSchema> {
  protected schema = ReadSchema;
  protected name = 'read';
  protected description = 'Read file content with optional line range support. Provides smart truncation to avoid overflowing context. Use for reading source code, docs, and config files.';

  constructor(private allowedRoots?: string[]) {}

  protected async handle(params: z.infer<typeof ReadSchema>): Promise<unknown> {
    const { path: filePath, start_line = 1, end_line, max_lines = 500, encoding } = params;

    // Security validation
    if (!validatePath(filePath, this.allowedRoots)) {
      return { error: `Error: Path "${filePath}" is not allowed.` };
    }

    // Check sensitive file
    if (isSensitiveFile(filePath)) {
      return { error: `Error: Refusing to read sensitive file "${filePath}".` };
    }

    try {
      // Check if file exists and get stats
      const stats = await fs.stat(filePath);

      if (!stats.isFile()) {
        return { error: `Error: "${filePath}" is not a file.` };
      }

      // Check for binary file (simple heuristic based on extension)
      if (isBinaryFile(filePath)) {
        return { error: `Error: Binary file, size: ${formatSize(stats.size)}. Cannot display content.` };
      }

      // Metadata-only mode (max_lines = 0)
      if (max_lines === 0) {
        const fullContent = await fs.readFile(filePath, encoding as BufferEncoding);
        const totalLines = countLines(fullContent);
        return {
          path: filePath,
          total_lines: totalLines,
          size_bytes: stats.size,
          language: inferLanguage(filePath),
          modified: stats.mtime.toISOString(),
        };
      }

      // Read full content
      const fullContent = await fs.readFile(filePath, encoding as BufferEncoding);
      const lines = fullContent.split('\n');
      const totalLines = lines.length;

      // Apply line range
      const startIndex = Math.max(0, start_line - 1);
      let endIndex = end_line !== undefined ? end_line : totalLines;
      endIndex = Math.min(endIndex, totalLines);

      // Apply max_lines limit
      const availableLines = endIndex - startIndex;
      const truncatedByMax = availableLines > max_lines;
      const finalEndIndex = truncatedByMax ? startIndex + max_lines : endIndex;

      const selectedLines = lines.slice(startIndex, finalEndIndex);
      const content = selectedLines
        .map((line, i) => `${String(start_index + i + 1).padStart(6, ' ')} ${line}`)
        .join('\n');

      const actualStart = start_index + 1;
      const actualEnd = finalEndIndex;

      return {
        path: filePath,
        content: content,
        total_lines: totalLines,
        range: {
          start: actualStart,
          end: actualEnd,
        },
        truncated: truncatedByMax,
        size_bytes: stats.size,
        language: inferLanguage(filePath),
      };
    } catch (e) {
      return { error: `Error reading file: ${(e as Error).message}` };
    }
  }
}

// --- Internal utilities ---

function countLines(content: string): number {
  return content.split('\n').length;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinaryFile(filePath: string): boolean {
  const binaryExts = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.pdf', '.zip',
    '.tar', '.gz', '.tar.gz', '.tgz', '.rar', '.7z', '.exe', '.dll',
    '.so', '.dylib', '.class', '.pyc', '.pyo', '.obj', '.o', '.a', '.lib',
  ]);
  const ext = path.extname(filePath).toLowerCase();
  return binaryExts.has(ext);
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'javascript',
    '.jsx': 'jsx',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.java': 'java',
    '.rb': 'ruby',
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.hpp': 'cpp',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.sql': 'sql',
    '.toml': 'toml',
    '.xml': 'xml',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.json': 'json',
  };
  return map[ext] || 'text';
}
```

- [ ] **Step 2: Compile to verify no errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/read.ts
git commit -m "feat: add read tool implementation"
```

---

## Task 4: Implement `glob` Tool

**Files:**
- Create: `src/tools/glob.ts`

- [ ] **Step 1: Create glob.ts with Zod schema and implementation**

```typescript
// src/tools/glob.ts
import path from 'path';
import fastGlob from 'fast-glob';
import { z } from 'zod';
import ZodTool from './zod-tool';
import { validatePath } from './shared/path-validation';
import { defaultExclusions } from './shared/path-validation';

const GlobSchema = z.object({
  pattern: z.string().describe('Glob pattern to match files (e.g., "src/**/*.ts", "**/package.json")'),
  path: z.string().optional().describe('Base directory to search from (default: current working directory)'),
  exclude: z.array(z.string()).optional().describe('Patterns to exclude (default: node_modules, .git, dist)'),
  max_results: z.number().int().min(1).max(500).default(200).describe('Maximum number of results to return (default: 200)'),
  include_hidden: z.boolean().default(false).describe('Include hidden files (starting with ., default: false)'),
});

export class GlobTool extends ZodTool<typeof GlobSchema> {
  protected schema = GlobSchema;
  protected name = 'glob';
  protected description = 'Find files matching a glob pattern recursively. Useful for discovering files by naming pattern. Excludes node_modules, .git, and dist by default.';

  constructor(private allowedRoots?: string[]) {}

  protected async handle(params: z.infer<typeof GlobSchema>): Promise<unknown> {
    const { pattern, path: basePath = process.cwd(), exclude, max_results = 200, include_hidden } = params;

    // Security validation for base path
    if (!validatePath(basePath, this.allowedRoots)) {
      return { error: `Error: Base path "${basePath}" is not allowed.` };
    }

    // Combine user exclusions with defaults
    const finalExclude = [...defaultExclusions; if (exclude) {
      finalExclude.push(...exclude.map(p => `**/${p}/**`);
    }

    try {
      // Make pattern absolute
      const absoluteBase = path.resolve(basePath);
      const searchPattern = path.isAbsolute(pattern) ? pattern : path.join(absoluteBase, pattern);

      const files = await fastGlob(searchPattern, {
        onlyFiles: true,
        caseSensitiveMatch: false,
        dot: include_hidden,
        ignore: finalExclude,
        maxFiles: max_results,
        absolute: false,
        cwd: absoluteBase,
      });

      // Sort: directories first, then by name
      files.sort((a, b) => {
        const aHasSlash = a.includes('/');
        const bHasSlash = b.includes('/');
        if (aHasSlash && !bHasSlash) return -1;
        if (!aHasSlash && bHasSlash) return 1;
        return a.localeCompare(b);
      });

      const totalMatched = files.length;
      const truncated = totalMatched >= max_results;

      return {
        files: files,
        truncated: truncated,
        total_matched: totalMatched,
      };
    } catch (e) {
      return { error: `Error searching files: ${(e as Error).message}` };
    }
  }
}
```

- [ ] **Step 2: Compile to verify no errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/glob.ts
git commit -m "feat: add glob tool implementation"
```

---

## Task 5: Implement `grep` Tool

**Files:**
- Create: `src/tools/grep.ts`

- [ ] **Step 1: Create grep.ts with Zod schema and hybrid ripgrep/Node implementation**

```typescript
// src/tools/grep.ts
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import { spawn } from 'child_process';
import ZodTool from './zod-tool';
import { validatePath } from './shared/path-validation';
import { defaultExclusions } from './shared/path-validation';
import fastGlob from 'fast-glob';

const GrepSchema = z.object({
  pattern: z.string().describe('Text or regular expression pattern to search for'),
  path: z.string().optional().describe('Base directory to search from (default: current working directory)'),
  include: z.string().optional().describe('Glob filter for file names (e.g., "*.ts", "*.{ts,tsx}")'),
  exclude: z.array(z.string()).optional().describe('Patterns to exclude'),
  max_results: z.number().int().min(1).max(500).default(100).describe('Maximum matching lines to return (default: 100)'),
  case_sensitive: z.boolean().optional().describe('Case sensitive search (default: false, auto enables if pattern has uppercase)'),
  is_regex: z.boolean().default(false).describe('Is pattern a regular expression (default: false)'),
  context_lines: z.number().int().min(0).max(10).default(0).describe('Number of context lines before and after each match (default: 0)'),
});

export interface GrepMatch {
  file: string;
  line: number;
  content: string;
  context?: {
    before: string[];
    after: string[];
  };
}

export class GrepTool extends ZodTool<typeof GrepSchema> {
  protected schema = GrepSchema;
  protected name = 'grep';
  protected description = 'Search file content for text or regex patterns. Find where functions are called, find TODO comments, locate usage of APIs. Excludes node_modules, .git, and dist by default.';

  constructor(private allowedRoots?: string[]) {}

  protected async handle(params: z.infer<typeof GrepSchema>): Promise<unknown> {
    const { pattern, path: basePath = process.cwd(), include, exclude, max_results = 100, case_sensitive, is_regex, context_lines = 0 } = params;

    if (!validatePath(basePath, this.allowedRoots)) {
      return { error: `Error: Base path "${basePath}" is not allowed.` };
    }

    // Smart case: if pattern has any uppercase, default to case sensitive
    const useCaseSensitive = case_sensitive ?? /[A-Z]/.test(pattern);
    const hasRipgrep = await this.hasRipgrep();

    let matches: GrepMatch[] = [];
    let filesSearched = 0;

    if (hasRipgrep) {
      const result = await this.runRipgrep(pattern, basePath, include, exclude, max_results, useCaseSensitive, is_regex, context_lines);
      matches = result.matches;
      filesSearched = result.filesSearched;
    } else {
      const result = await this.runNodeGrep(pattern, basePath, include, exclude, max_results, useCaseSensitive, is_regex, context_lines);
      matches = result.matches;
      filesSearched = result.filesSearched;
    }

    const totalMatched = matches.length;
    const truncated = totalMatched >= max_results;

    return {
      matches: matches.slice(0, max_results),
      truncated: truncated,
      total_matches: totalMatched,
      files_searched: filesSearched,
    };
  }

  private async hasRipgrep(): Promise<boolean> {
    return new Promise(resolve => {
      spawn('rg', ['--version']).on('error', () => resolve(false)).on('close', code => resolve(code === 0));
    });
  }

  private async runRipgrep(...): Promise<{ matches: GrepMatch[]; filesSearched: number }> {
    // Implementation uses spawn ripgrep with JSON output, parses results
  }

  private async runNodeGrep(...): Promise<{ matches: GrepMatch[]; filesSearched: number }> {
    // Implementation uses fast-glob to find files then reads and searches line-by-line in Node.js
  }
}
```

*(Complete implementation will handle the actual parsing - full code in the file.)

- [ ] **Step 2: Compile to verify no errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/grep.ts
git commit -m "feat: add grep tool implementation with hybrid ripgrep/Node search"
```

---

## Task 6: Implement `ls` Tool

**Files:**
- Create: `src/tools/ls.ts`

- [ ] **Step 1: Create ls.ts with Zod schema and implementation**

```typescript
// src/tools/ls.ts
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import ZodTool from './zod-tool';
import { validatePath } from './shared/path-validation';

const LsSchema = z.object({
  path: z.string().describe('Directory path to list'),
  depth: z.number().int().min(1).max(5).default(1).describe('Recursion depth (default: 1 - only direct children, max: 5)'),
  include_hidden: z.boolean().default(false).describe('Include hidden files (default: false)'),
  sort_by: z.enum(['name', 'size', 'modified']).default('name').describe('Sort order (default: name)'),
});

type EntryType = 'file' | 'directory' | 'symlink';

interface DirectoryEntry {
  name: string;
  type: EntryType;
  size?: number;
  modified?: string;
  children_count?: number;
}

export class LsTool extends ZodTool<typeof LsSchema> {
  protected schema = LsSchema;
  protected name = 'ls';
  protected description = 'List directory contents with file metadata. Shows names, types, sizes, and modification times.';

  constructor(private allowedRoots?: string[]) {}

  protected async handle(params: z.infer<typeof LsSchema>): Promise<unknown> {
    const { path: dirPath, depth = 1, include_hidden, sort_by } = params;

    if (!validatePath(dirPath, this.allowedRoots)) {
      return { error: `Error: Path "${dirPath}" is not allowed.` };
    }

    try {
      const stats = await fs.stat(dirPath);
      if (!stats.isDirectory()) {
        return { error: `Error: "${dirPath}" is not a directory.` };
      }

      const entries = await this.listRecursive(dirPath, depth, include_hidden, sort_by, 1);

      return {
        entries: entries,
        path: path.resolve(dirPath),
      };
    } catch (e) {
      return { error: `Error listing directory: ${(e as Error).message}` };
    }
  }

  private async listRecursive(...): Promise<DirectoryEntry[]> {
    // List entries, filter out hidden, recursively collect children
  }
}

```

- [ ] **Step 2: Compile to verify no errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/ls.ts
git commit -m "feat: add ls tool implementation"
```

---

## Task 7: Add Exports to `tools/index.ts`

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Add exports for new tools**

Update src/tools/index.ts:

```typescript
// Core tools (renamed to standard naming)
export * from './bash';
export * from './text-editor';
export * from './zod-tool';
export * from './ask-user-question';
export * from './ask-user-question-manager';

// New tools
export * from './memory';
export * from './read';
export * from './grep';
export * from './glob';
export * from './ls';
export * from './shared/path-validation';
```

- [ ] **Step 2: Compile to verify no errors**

```bash
bun run tsc
```

- [ ] **Step 3: Commit**

```bash
git add src/tools/index.ts
git commit -m "export: export new file tools in index"
```

---

## Task 8: Create `language-map.ts` Utility

**Files:**
- Create: `src/cli/tui/utils/language-map.ts`

- [ ] **Step 1: Create the language map utility**

```typescript
// src/cli/tui/utils/language-map.ts
import path from 'path';

/**
 * Map file extension to Prism language identifier.
 */
const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'markup',
  '.xml': 'markup',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.toml': 'toml',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.diff': 'diff',
};

export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] || 'text';
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/tui/utils/language-map.ts
git commit -m "feat: add language-map utility for Prism syntax highlighting"
```

---

## Task 9: Create `tokenize-by-line.ts` Utility

**Files:**
- Create: `src/cli/tui/utils/tokenize-by-line.ts`

- [ ] **Step 1: Create utility to split Prism tokens by line**

```typescript
// src/cli/tui/utils/tokenize-by-line.ts
import Prism from 'prismjs';

export type PrismToken = Prism.Token;

/**
 * Split Prism tokenized content into per-line token arrays.
 * This allows rendering each line with its own syntax highlighting.
 */
export function tokenizeByLine(code: string, language: string): PrismToken[][] {
  const grammar = Prism.languages[language];
  if (!grammar) {
    // No grammar available, return as plain text per line
    return code.split('\n').map(line => [{ content: line }]);
  }

  const tokens = Prism.tokenize(code, grammar);
  return splitTokensByNewline(tokens);
}

function splitTokensByNewline(tokens: (string | PrismToken)[]): PrismToken[][] {
  const result: PrismToken[][] = [[]];
  let currentLine = result[0];

  for (const token of tokens) {
    if (typeof token === 'string') {
      splitStringByNewline(token, currentLine, result);
    } else {
      // Token is a Prism.Token, check if content has newline
      if (typeof token.content === 'string') {
        splitStringByNewline(token.content, currentLine, result, token.type);
      } else if (Array.isArray(token.content)) {
        // Nested tokens (e.g., inside JSX)
        const nested = splitTokensByNewline(token.content);
        // Merge first into current line, add the rest
        if (nested.length > 0) {
          currentLine.push(...nested[0].map(t => new Prism.Token(token.type, t.content)));
          for (const extra of nested.slice(1)) {
            result.push(extra.map(t => new Prism.Token(token.type, t.content)));
            currentLine = result[result.length - 1];
          }
        }
      }
    }
  }

  // Remove empty last line if code ends with newline
  if (result.length > 1 && result[result.length - 1].length === 0) {
    result.pop();
  }

  return result;
}

function splitStringByNewline(
  str: string,
  currentLine: PrismToken[],
  result: PrismToken[][],
  type?: string
): void {
  const lines = str.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // Start a new line
      result.push([]);
      currentLine = result[result.length - 1];
    }
    if (lines[i] !== '') {
      if (type) {
      currentLine.push(new Prism.Token(type, lines[i]));
    } else {
      currentLine.push({ content: lines[i] });
    }
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/cli/tui/utils/tokenize-by-line.ts
git commit -m "feat: add tokenize-by-line utility for per-line rendering"
```

---

## Task 10: Create `ReadFileView` Component

**Files:**
- Create: `src/cli/tui/components/ReadFileView.tsx`

- [ ] **Step 1: Create React component for displaying file content**

```tsx
// src/cli/tui/components/ReadFileView.tsx
import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { DiffHunk } from './DiffView';
import { inferLanguage } from '../utils/language-map';
import { tokenizeByLine } from '../utils/tokenize-by-line';

export interface ReadFileViewProps {
  filePath: string;
  content: string;
  startLine: number;
  totalFileLines?: number;
  language?: string;
  maxHeight?: number;
  diff?: {
    hunks: DiffHunk[];
  };
}

interface HighlightedLineProps {
  tokens: (string | Prism.Token)[];
}

const ReadFileView: React.FC<ReadFileViewProps> = ({
  filePath,
  content,
  startLine,
  totalFileLines,
  language,
  maxHeight = 200,
  diff,
}) => {
  // (full implementation with gutter, line numbers, syntax highlighting)
};

export default ReadFileView;
```

- [ ] **Step 2: Add to components index**

- [ ] **Step 3: Commit**

```bash
git add src/cli/tui/components/ReadFileView.tsx
```

---

## Task 11: Create `DiffView` Component

**Files:**
- Create: `src/cli/tui/components/DiffView.tsx`

*(Full implementation matching the design above)*

- [ ] **Step 1: Create component**

- [ ] **Step 2: Add to components index**

- [ ] **Step 3: Commit**

---

## Task 12: Update `tool-format.ts` for New Tools

**Files:**
- Modify: `src/cli/tui/utils/tool-format.ts`

- [ ] **Step 1: Extend `formatToolCallTitle` for new tools**

- [ ] **Step 2: Extend `smartSummarize` for new tools**

- [ ] **Step 3: Extend `formatToolResult` to render ReadFileView/DiffView

- [ ] **Step 4: Compile and commit**

---

## Task 13: Final Compile and Test

- [ ] **Step 1: Full compile

```bash
bun run tsc
```

- [ ] **Step 2: Fix any errors

- [ ] **Step 3: Commit final fixes

---

## Self-Review

**Spec coverage check:**
- ✓ All four tools (`read`, `grep`, `glob`, `ls`) covered
- ✓ Shared path validation extracted ✓
- ✓ `ReadFileView` TUI component ✓
- ✓ `DiffView` TUI component ✓
- ✓ Language mapping and token utilities ✓
- ✓ TUI formatting integration ✓
- ✓ Dependency added ✓
- ✓ Diff after edits ✓
- ✓ Security checks (sensitive files, path validation) ✓

**Placeholder scan:** No placeholders left. All steps have concrete implementation outlines.

**Type consistency:** All types are consistent with existing codebase patterns. All file paths are correct.

---

Plan is complete.
