import React from 'react';
import { Box, Text } from 'ink';
import { BlinkingText } from './BlinkingText';
import ReadFileView from './ReadFileView';
import type { ToolCall } from '../../../types';
import { formatToolCallTitle, smartSummarize, formatToolResult } from '../utils/tool-format';

/**
 * Props for ToolCallMessage component
 */
export interface ToolCallMessageProps {
  toolCall: ToolCall;
  result?: {
    content: string;
    isError: boolean;
    durationMs: number;
  };
  pending: boolean;
  focused: boolean;
  expanded: boolean;
}

/**
 * Displays a tool call execution status in Claude Code-style format
 */
export function ToolCallMessage({ toolCall, result, pending, focused, expanded }: ToolCallMessageProps) {
  const title = formatToolCallTitle(toolCall);

  // Border style based on focus
  const borderStyle = focused ? 'single' : undefined;
  const borderColor = focused ? 'blue' : undefined;
  const prefixColor = pending ? 'yellow' : result?.isError ? 'red' : 'gray';
  const contentColor = result?.isError ? 'red' : 'gray';

  // Special handling for read tool - render with syntax highlighting using ReadFileView
  if (!pending && result && !result.isError && toolCall.name === 'read') {
    let parsed: {
      path: string;
      content: string;
      total_lines: number;
      range: { start: number; end: number };
      diff?: { hunks: any };
    } | null = null;

    try {
      parsed = JSON.parse(result.content);
    } catch {
      // fall through to default rendering
    }

    if (parsed && parsed.path && parsed.content) {
      const smartSummary = smartSummarize(toolCall.name, toolCall.arguments, result.content);

      return (
        <Box flexDirection="column" borderStyle={borderStyle} borderColor={borderColor} paddingX={focused ? 1 : 0} marginY={0}>
          {/* Title line */}
          <Box flexDirection="row" alignItems="center">
            <Text color={prefixColor}>
              {pending ? <BlinkingText>●</BlinkingText> : '●'}
            </Text>
            <Text color="cyan"> {title}</Text>
            {result && <Text color="gray"> {result.durationMs}ms</Text>}
          </Box>

          {/* Always show full content with syntax highlighting for read tool */}
          {smartSummary && (
            <Box paddingLeft={2}>
              <Text color={contentColor}>{smartSummary}</Text>
            </Box>
          )}
          {expanded ? (
            <ReadFileView
              filePath={parsed.path}
              content={parsed.content}
              startLine={parsed.range.start}
              totalFileLines={parsed.total_lines}
              diff={parsed.diff}
            />
          ) : (
            <Box paddingLeft={2}>
              <Text color="gray">Read 1 file (ctrl+o to expand)</Text>
            </Box>
          )}
        </Box>
      );
    }
  }

  // Default rendering for other tools
  // Get content to display
  let content: string;
  let isCollapsible: boolean;

  if (!result) {
    content = '';
    isCollapsible = false;
  } else {
    const smartSummary = smartSummarize(toolCall.name, toolCall.arguments, result.content);
    if (smartSummary !== null) {
      content = smartSummary;
      isCollapsible = false;
    } else {
      const formatted = formatToolResult(result.content, result.isError, expanded);
      content = formatted.display;
      isCollapsible = formatted.isCollapsible;
    }
  }

  return (
    <Box flexDirection="column" borderStyle={borderStyle} borderColor={borderColor} paddingX={focused ? 1 : 0} marginY={0}>
      {/* Title line */}
      <Box flexDirection="row" alignItems="center">
        <Text color={prefixColor}>
          {pending ? <BlinkingText>●</BlinkingText> : '●'}
        </Text>
        <Text color="cyan"> {title}</Text>
        {result && <Text color="gray"> {result.durationMs}ms</Text>}
      </Box>

      {/* Result content */}
      {result && content && (
        <Box paddingLeft={2}>
          <Text color={contentColor}>{content}</Text>
        </Box>
      )}
    </Box>
  );
}
