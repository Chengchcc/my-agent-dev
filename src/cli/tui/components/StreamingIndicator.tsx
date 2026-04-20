import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming } = useAgentLoop();

  if (!streaming) return null;

  return (
    <Box>
      <Text color="gray">
        <Text dimColor>Thinking...</Text>
        {nextTodo && ` Next: ${nextTodo}`}
      </Text>
    </Box>
  );
}