import { Box, Text } from 'ink';
import React, { useEffect, useRef, useState } from 'react';
import type { Message } from '../../../types';
import type { ToolCallStartEvent } from '../../../agent/loop-types';
import { useAgentLoop } from '../hooks';

// Spinner frames for smooth animation
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_FRAME_INTERVAL_MS = 80;
const MS_PER_SECOND = 1000;
const ELAPSED_SEC_PAD_WIDTH = 6;
const TURN_STR_PAD_WIDTH = 3;

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
    }, SPINNER_FRAME_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [streaming]);

  const elapsedMs = streamingStartTime ? Date.now() - streamingStartTime : 0;
  const elapsedSec = ((elapsedMs / MS_PER_SECOND).toFixed(1)).padStart(ELAPSED_SEC_PAD_WIDTH);
  // Turn count = number of completed assistant messages + this current turn
  const turnCount = messages.filter(m => m.role === 'assistant').length;
  const turnStr = String(turnCount).padStart(TURN_STR_PAD_WIDTH);

  const hasRunningTools = currentTools.length > 0;
  const statusText = hasRunningTools
    ? `Running ${currentTools.map(t => t.toolCall.name).join(', ')}...`
    : 'Thinking...';

  return (
    <Box height={1} gap={2}>
      {streaming ? (
        <>
          <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
          <Text dimColor>{statusText}</Text>
          <Text dimColor>Turn {turnStr}</Text>
          <Text dimColor>{elapsedSec}s</Text>
          {nextTodo ? <Text dimColor>Next: {nextTodo}</Text> : null}
          <Text dimColor>[esc to interrupt]</Text>
        </>
      ) : (
        <Text>{' '}</Text>
      )}
    </Box>
  );
}

/**
 * Connected streaming indicator that reads state from AgentLoopContext
 */
export function StreamingIndicator({ nextTodo }: { nextTodo?: string }) {
  const { streaming, streamingStartTime, currentTools, messages } = useAgentLoop();
  const props: PureStreamingIndicatorProps = { streaming, streamingStartTime, currentTools, messages };
  if (nextTodo) props.nextTodo = nextTodo;
  return <PureStreamingIndicator {...props} />;
}
