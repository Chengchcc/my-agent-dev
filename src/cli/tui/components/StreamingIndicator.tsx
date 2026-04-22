import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import { BlinkingText } from './';
import { useAgentLoop } from '../hooks';

export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime, messages } = useAgentLoop();
  const [, forceUpdate] = useState({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (streaming && streamingStartTime) {
      // Refresh at 500ms interval instead of 100ms - enough for second accuracy
      intervalRef.current = setInterval(() => {
        forceUpdate({});
      }, 500);
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
  // Turn count = number of completed assistant messages + this current turn
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
