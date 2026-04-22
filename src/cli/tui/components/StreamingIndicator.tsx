import { Box, Text } from 'ink';
import React from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming } = useAgentLoop();

  if (!streaming) return null;

  return (
    <Box>
      <Text color="gray">
        <BlinkingText dimColor interval={800}>Thinking...</BlinkingText>
        {nextTodo && ` Next: ${nextTodo}`}
      </Text>
    </Box>
  );
}