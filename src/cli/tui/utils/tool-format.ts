import type { ToolCall } from '../../../types';

interface DiffData {
  hunks?: Array<{
    oldStart?: number;
    oldLines?: number;
    newStart?: number;
    newLines?: number;
    lines?: Array<{ type: string; content: string }>;
  }>;
}

// Truncation lengths for tool call titles
const BASH_CMD_TRUNCATION = 80;
const SUB_AGENT_TASK_TRUNCATION = 60;
const GREP_PATTERN_TRUNCATION = 40;
const DEFAULT_ARG_TRUNCATION = 30;

// Result folding thresholds
const RESULT_COLLAPSIBLE_MIN_LINES = 3;
const ERROR_DISPLAY_LINES = 10;
const MEDIUM_RESULT_MAX_LINES = 20;
const LONG_RESULT_HEAD_LINES = 5;
const LONG_RESULT_TAIL_LINES = 3;
const ELLIPSIS_LENGTH = 3;

/**
 * Truncate string to max length
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - ELLIPSIS_LENGTH) + '...';
}

function countAdded(diff: DiffData): number {
  let count = 0;
  if (diff.hunks) {
    for (const hunk of diff.hunks) {
      if (hunk.lines) {
        for (const line of hunk.lines) {
          if (line.type === 'added') count++;
        }
      }
    }
  }
  return count;
}

function countRemoved(diff: DiffData): number {
  let count = 0;
  if (diff.hunks) {
    for (const hunk of diff.hunks) {
      if (hunk.lines) {
        for (const line of hunk.lines) {
          if (line.type === 'removed') count++;
        }
      }
    }
  }
  return count;
}

/**
 * Format one-line tool call title with parameter summary
 */
export function formatToolCallTitle(toolCall: ToolCall): string {
  const { name, arguments: args } = toolCall;

  switch (name) {
    case 'bash': {
      const cmd = truncate(String(args.command ?? ''), BASH_CMD_TRUNCATION);
      return `bash(${JSON.stringify(cmd)})`;
    }

    case 'text_editor': {
      const sub = String(args.command ?? 'view');
      const path = String(args.path ?? args.file_path ?? '');
      return `text_editor(${sub}, ${JSON.stringify(path)})`;
    }

    case 'sub_agent': {
      const task = truncate(String(args.task ?? ''), SUB_AGENT_TASK_TRUNCATION);
      return `sub_agent(${JSON.stringify(task)})`;
    }

    case 'read': {
      const path = String(args.path ?? '');
      const startLine = args.start_line ? Number(args.start_line) : 1;
      const endLine = args.end_line ? Number(args.end_line) : 'end';
      return `read(${JSON.stringify(path)}, lines ${startLine}-${endLine})`;
    }

    case 'grep': {
      const pattern = truncate(String(args.pattern ?? ''), GREP_PATTERN_TRUNCATION);
      return `grep(${JSON.stringify(pattern)})`;
    }

    case 'glob': {
      return `glob(${JSON.stringify(String(args.pattern ?? ''))})`;
    }

    case 'ls': {
      return `ls(${JSON.stringify(String(args.path ?? ''))})`;
    }

    default: {
      const entries = Object.entries(args).slice(0, 2);
      const summary = entries
        .map(([k, v]) => `${k}=${JSON.stringify(truncate(String(v), DEFAULT_ARG_TRUNCATION))}`)
        .join(', ');
      return `${name}(${summary})`;
    }
  }
}

/**
 * Smart summarization for specific tool types
 * Returns null if no special summary applies
 */
 
// eslint-disable-next-line complexity
export function smartSummarize(
  toolName: string,
  args: Record<string, unknown>,
  result: string
): string | null {
  // Bash special cases
  if (toolName === 'bash') {
    const cmd = String(args.command ?? '');

    // tsc compilation
    if (cmd.includes('tsc')) {
      if (!result.trim()) return '✓ No errors';
      const errorCount = (result.match(/error TS/g) || []).length;
      return `✗ ${errorCount} error${errorCount > 1 ? 's' : ''}`;
    }

    // test runners
    if (cmd.includes('vitest') || cmd.includes('jest')) {
      const passMatch = result.match(/(\d+) passed/);
      const failMatch = result.match(/(\d+) failed/);
      if (passMatch || failMatch) {
        const parts: string[] = [];
        if (failMatch) parts.push(`${failMatch[1]} failed`);
        if (passMatch) parts.push(`${passMatch[1]} passed`);
        return `${failMatch ? '✗ ' : '✓ '}${parts.join(', ')}`;
      }
    }

    // empty output
    if (!result.trim()) return '(no output)';
  }

  // text_editor special cases
  if (toolName === 'text_editor') {
    const cmd = String(args.command ?? 'view');
    if (cmd === 'view') {
      const lineCount = result.split('\n').length;
      return `(${lineCount} lines)`;
    }
    if (cmd === 'create') {
      const lineCount = ((args.file_text as string) ?? '').split('\n').length;
      return `✓ Created (${lineCount} lines)`;
    }
    if (cmd === 'str_replace') {
      return '✓ Replaced';
    }
  }

  // read tool special cases
  if (toolName === 'read') {
    try {
      const parsedResult = JSON.parse(result);
      const start = parsedResult.range?.start || 1;
      const end = parsedResult.range?.end || parsedResult.total_lines;
      const lineRange = start === 1 && end === parsedResult.total_lines
        ? `${parsedResult.total_lines} lines`
        : `lines ${start}-${end} of ${parsedResult.total_lines}`;
      const diffTag = parsedResult.diff
        ? ` (${countAdded(parsedResult.diff)} added, ${countRemoved(parsedResult.diff)} removed)`
        : '';
      return `${parsedResult.path} — ${lineRange}${diffTag}`;
    } catch (_e) {
      // If parsing fails, return default summary
      return `Read file operation completed`;
    }
  }

  // grep tool special cases
  if (toolName === 'grep') {
    try {
      const parsedResult = JSON.parse(result);
      return `${parsedResult.matches.length} matches in ${parsedResult.files_searched} files`;
    } catch (_e) {
      return `Grep search completed`;
    }
  }

  // glob tool special cases
  if (toolName === 'glob') {
    try {
      const parsedResult = JSON.parse(result);
      return `${parsedResult.files.length} files${parsedResult.truncated ? ' (truncated)' : ''}`;
    } catch (_e) {
      return `Glob search completed`;
    }
  }

  // ls tool special cases
  if (toolName === 'ls') {
    try {
      const parsedResult = JSON.parse(result);
      return `${parsedResult.entries.length} entries`;
    } catch (_e) {
      return `List directory completed`;
    }
  }

  return null;
}

/**
 * Result formatting with folding
 */
export function formatToolResult(
  result: string,
  isError: boolean,
  expanded: boolean
): { display: string; isCollapsible: boolean } {
  const lines = result.split('\n');

  // Expanded: show everything
  if (expanded) {
    return { display: result, isCollapsible: lines.length > RESULT_COLLAPSIBLE_MIN_LINES };
  }

  // Errors: always show first ERROR_DISPLAY_LINES lines
  if (isError) {
    const display =
      lines.slice(0, ERROR_DISPLAY_LINES).join('\n') +
      (lines.length > ERROR_DISPLAY_LINES ? `\n... (${lines.length} lines total)` : '');
    return { display, isCollapsible: lines.length > ERROR_DISPLAY_LINES };
  }

  // Short result: full display
  if (lines.length <= RESULT_COLLAPSIBLE_MIN_LINES) {
    return { display: result, isCollapsible: false };
  }

  // Medium result: first ERROR_DISPLAY_LINES lines + summary
  if (lines.length <= MEDIUM_RESULT_MAX_LINES) {
    const display = lines.slice(0, ERROR_DISPLAY_LINES).join('\n') + `\n... (${lines.length} lines)`;
    return { display, isCollapsible: true };
  }

  // Long result: first LONG_RESULT_HEAD_LINES + ... + last LONG_RESULT_TAIL_LINES
  const display = [
    ...lines.slice(0, LONG_RESULT_HEAD_LINES),
    `... (${lines.length - LONG_RESULT_HEAD_LINES - LONG_RESULT_TAIL_LINES} more lines)`,
    ...lines.slice(-LONG_RESULT_TAIL_LINES),
  ].join('\n');
  return { display, isCollapsible: true };
}
