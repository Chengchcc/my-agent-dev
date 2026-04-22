import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime } = useAgentLoop();
  const [, forceUpdate] = useState({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (streaming && streamingStartTime) {
      intervalRef.current = setInterval(() => {
        forceUpdate({});
      }, 100);
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming, streamingStartTime]);

  if (!streaming) return null;

  const elapsedMs = streamingStartTime ? Date.now() - streamingStartTime : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  const { messages } = useAgentLoop();
  const turnCount = messages.filter(m => m.role === 'assistant').length;

  return (
    <Box gap={2}>
      <BlinkingText color="gray">⠋ Thinking...</BlinkingText>
      <Text dimColor>Turn {turnCount}</Text>
      <Text dimColor>{elapsedSec}s</Text>
      {nextTodo && <Text dimColor>Next: {nextTodo}</Text>}
    </Box>
  );
}
