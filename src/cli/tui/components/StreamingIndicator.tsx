import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { Message } from '../../../types';
import type { ToolCallStartEvent } from '../../../agent/loop-types';
import { useAgentLoop } from '../hooks';

// Spinner frames for smooth animation
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface PureStreamingIndicatorProps {
  streaming: boolean;
  streamingStartTime: number | null;
  currentTools: ToolCallStartEvent[];
  messages: Message[];
  nextTodo?: string;
}

/**
 * Pure (context-free) streaming indicator for testing
 */
export function PureStreamingIndicator({
  streaming,
  streamingStartTime,
  currentTools,
  messages,
  nextTodo,
}: PureStreamingIndicatorProps) {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!streaming) return;

    // Animate spinner at 80ms interval for smooth rotation
    intervalRef.current = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming]);

  if (!streaming) return null;

  const elapsedMs = streamingStartTime ? Date.now() - streamingStartTime : 0;
  const elapsedSec = (elapsedMs / 1000).toFixed(1);
  // Turn count = number of completed assistant messages + this current turn
  const turnCount = messages.filter(m => m.role === 'assistant').length;

  const hasRunningTools = currentTools.length > 0;
  const statusText = hasRunningTools
    ? `Running ${currentTools.map(t => t.toolCall.name).join(', ')}...`
    : 'Thinking...';

  return (
    <Box gap={2}>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor>{statusText}</Text>
      <Text dimColor>Turn {turnCount}</Text>
      <Text dimColor>{elapsedSec}s</Text>
      {nextTodo && <Text dimColor>Next: {nextTodo}</Text>}
      <Text dimColor>[esc to interrupt]</Text>
    </Box>
  );
}

/**
 * Connected streaming indicator that reads state from AgentLoopContext
 */
export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime, currentTools, messages } = useAgentLoop();
  const props: any = { streaming, streamingStartTime, currentTools, messages };
  if (nextTodo) props.nextTodo = nextTodo;
  return <PureStreamingIndicator {...props} />;
}
