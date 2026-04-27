import React from 'react';
import { Box, Text } from 'ink';

interface ThinkingMessageProps {
  content: string;
  /** Whether the thinking is being streamed (animate) */
  streaming?: boolean;
}

export function ThinkingMessage({ content, streaming }: ThinkingMessageProps) {
  if (!content) return null;

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text dimColor italic>
        {streaming ? 'Thinking...' : 'Thought process'}
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{content}</Text>
      </Box>
    </Box>
  );
}
