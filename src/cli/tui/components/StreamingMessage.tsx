import React from 'react';
import { Box, Text } from 'ink';

interface StreamingMessageProps {
  content: string;
}

/**
 * Lightweight streaming message component that renders pure text
 * during streaming to avoid expensive Markdown parsing on every delta.
 * After streaming completes, the full message is re-rendered by ChatMessage
 * with full Markdown parsing and syntax highlighting.
 */
export function StreamingMessage({ content }: StreamingMessageProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{'<'} </Text>
        <Text color="cyan">assistant:</Text>
      </Box>
      <Box paddingLeft={1}>
        <Text>{content}</Text>
      </Box>
    </Box>
  );
}
