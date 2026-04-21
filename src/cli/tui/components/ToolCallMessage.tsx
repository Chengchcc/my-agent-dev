// src/cli/tui/components/ToolCallMessage.tsx
import React from 'react';
import { Box, Text, Spacer } from 'ink';
import type { ToolCall } from '../../../types';
import type { ToolCallResultEvent } from '../../../agent/loop-types';

/**
 * Props for ToolCallMessage component
 */
interface ToolCallMessageProps {
  toolCall: ToolCall;
  status: 'running' | 'completed' | 'error';
  result?: ToolCallResultEvent['result'];
  error?: Error;
}

/**
 * Displays a tool call execution status in the chat history
 */
export function ToolCallMessage({ toolCall, status, result, error }: ToolCallMessageProps) {
  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        <Text bold>Tool: {toolCall.name}</Text>
        <Spacer />
        {status === 'running' && <Text color="yellow">Running...</Text>}
        {status === 'completed' && <Text color="green">✓ Done</Text>}
        {status === 'error' && <Text color="red">✗ Error</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Arguments: {JSON.stringify(toolCall.arguments, null, 2)}</Text>
      </Box>
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
      {error && (
        <Box marginTop={1}>
          <Text color="red">Error: {error.message}</Text>
        </Box>
      )}
    </Box>
  );
}
