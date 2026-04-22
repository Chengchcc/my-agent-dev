import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';

export function Footer() {
  const { totalUsage, tokenLimit } = useAgentLoop();

  const percentage = tokenLimit > 0 ? Math.round((totalUsage.totalTokens / tokenLimit) * 100) : 0;
  const barWidth = 20;
  const filled = tokenLimit > 0 ? Math.round(barWidth * totalUsage.totalTokens / tokenLimit) : 0;
  const empty = barWidth - filled;

  // Color based on percentage
  let color: 'gray' | 'yellow' | 'red' = 'gray';
  if (percentage > 80) {
    color = 'red';
  } else if (percentage > 60) {
    color = 'yellow';
  }

  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <Box marginTop={1} width="100%" justifyContent="space-between">
      <Text dimColor>Type /exit to quit, /clear to clear conversation</Text>
      <Box gap={1}>
        {totalUsage.totalTokens > 0 && (
          <>
            <Text dimColor>Tokens: {totalUsage.totalTokens.toLocaleString()}</Text>
            <Text dimColor>
              Context: <Text color={color}>{bar}</Text> {percentage}%
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}
