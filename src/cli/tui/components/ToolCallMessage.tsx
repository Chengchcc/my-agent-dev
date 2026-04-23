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

  // Border style based on focus
  const borderStyle = focused ? 'single' : undefined;
  const borderColor = focused ? 'blue' : undefined;
  const prefixColor = pending ? 'yellow' : result?.isError ? 'red' : 'gray';
  const contentColor = result?.isError ? 'red' : 'gray';

  return (
    <Box flexDirection="column" borderStyle={borderStyle} borderColor={borderColor} paddingX={focused ? 1 : 0} marginY={0}>
      {/* Title line */}
      <Box flexDirection="row" alignItems="center">
        <Text color={prefixColor}>
          {pending ? <BlinkingText>⠋</BlinkingText> : '❯'}
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
