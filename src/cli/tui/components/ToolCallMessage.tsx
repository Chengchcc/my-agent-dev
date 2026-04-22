// src/cli/tui/components/ToolCallMessage.tsx
import React from 'react';
import { Box, Text, Spacer } from 'ink';
import { BlinkingText } from './';
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

function renderKeyValue(obj: unknown, indent: number = 0): React.ReactNode {
  if (typeof obj !== 'object' || obj === null) {
    return <Text dimColor>{String(obj)}</Text>;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) {
      return <Text dimColor>[]</Text>;
    }
    return (
      <Box flexDirection="column" paddingLeft={indent * 2}>
        {obj.map((item, i) => (
          <Box key={i} flexDirection="row" gap={1}>
            <Text bold color="cyan">{i}:</Text>
            {renderKeyValue(item, indent + 1)}
          </Box>
        ))}
      </Box>
    );
  }

  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return <Text dimColor>{'{}'}</Text>;
  }

  return (
    <Box flexDirection="column" paddingLeft={indent * 2}>
      {entries.map(([key, value]) => (
        <Box key={key} flexDirection="row" gap={1}>
          <Text bold color="cyan">{key}:</Text>
          {renderKeyValue(value, indent + 1)}
        </Box>
      ))}
    </Box>
  );
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
        {status === 'running' && <BlinkingText color="yellow">Running...</BlinkingText>}
        {status === 'completed' && <Text color="green">✓ Done</Text>}
        {status === 'error' && <Text color="red">✗ Error</Text>}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Arguments: {JSON.stringify(toolCall.arguments, null, 2)}</Text>
      </Box>
      {result !== undefined && status !== 'running' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Output:</Text>
          <Box paddingTop={0} paddingLeft={1}>
            {typeof result === 'string' ? (
              <Text dimColor>{result}</Text>
            ) : (
              renderKeyValue(result)
            )}
          </Box>
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
