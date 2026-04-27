import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useAgentLoop } from '../hooks';

interface DebugOverlayProps {
  enabled: boolean;
}

const MAX_EVENTS = 5;

export function DebugOverlay({ enabled }: DebugOverlayProps) {
  if (!enabled) return null;

  const { messages, currentTools, streaming, todos } = useAgentLoop();
  const [stallMs, setStallMs] = useState(0);
  const [lastEvents, setLastEvents] = useState<string[]>([]);

  // Lightweight event loop stall monitoring for debug overlay
  useEffect(() => {
    const id = setInterval(() => {
      const start = performance.now();
      setImmediate(() => {
        setStallMs(Math.round(performance.now() - start));
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Track recent events
  useEffect(() => {
    const event = `turn:${messages.filter(m => m.role === 'assistant').length} stream:${streaming} tools:${currentTools.length} todos:${todos.length}`;
    setLastEvents(prev => [...prev.slice(-(MAX_EVENTS - 1)), event]);
  }, [messages.length, streaming, currentTools.length, todos.length]);

  const turnCount = messages.filter(m => m.role === 'assistant').length;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Box gap={2}>
        <Text dimColor>
          turn:{turnCount} stall:{stallMs}ms tools:{currentTools.length} stream:{streaming ? 'Y' : 'N'}
        </Text>
      </Box>
      <Box>
        <Text dimColor>
          last: {lastEvents.join(' | ')}
        </Text>
      </Box>
    </Box>
  );
}
