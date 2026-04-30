import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';
import { useAgentLoop } from '../hooks';

const STALL_MONITOR_INTERVAL_MS = 1000;

interface DebugOverlayProps {
  enabled: boolean;
}

const MAX_EVENTS = 5;

export function DebugOverlay({ enabled }: DebugOverlayProps) {
  const { messages, currentTools, streaming, todos } = useAgentLoop();
  const [stallMs, setStallMs] = useState(0);
  const [lastEvents, setLastEvents] = useState<string[]>([]);

  // Lightweight event loop stall monitoring for debug overlay
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const start = performance.now();
      setImmediate(() => {
        setStallMs(Math.round(performance.now() - start));
      });
    }, STALL_MONITOR_INTERVAL_MS);
    return () => clearInterval(id);
  }, [enabled]);

  // Track recent events — bail out if event signature hasn't changed
  useEffect(() => {
    if (!enabled) return;
    const event = `turn:${messages.filter(m => m.role === 'assistant').length} stream:${streaming} tools:${currentTools.length} todos:${todos.length}`;
    setLastEvents(prev => {
      if (prev[prev.length - 1] === event) return prev;
      return [...prev.slice(-(MAX_EVENTS - 1)), event];
    });
  }, [enabled, messages.length, streaming, currentTools.length, todos.length]);

  if (!enabled) return null;

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
