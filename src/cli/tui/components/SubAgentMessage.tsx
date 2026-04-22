// src/cli/tui/components/SubAgentMessage.tsx
import React, { useState } from 'react';
import { Box, Text, Spacer } from 'ink';
import type { SubAgentStartEvent } from '../../../agent/loop-types';
import { BlinkingText } from './BlinkingText';

/**
 * Props for SubAgentMessage component
 */
interface SubAgentMessageProps {
  startEvent: SubAgentStartEvent;
  completed?: { summary: string; totalTurns: number; durationMs: number };
  isRunning: boolean;
}

/**
 * Displays a sub agent execution with collapsible details
 */
export function SubAgentMessage({ startEvent, completed, isRunning }: SubAgentMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const { agentId, task } = startEvent;

  // Truncate task for display in header
  const shortTask = task.length > 60 ? task.slice(0, 57) + '...' : task;

  return (
    <Box flexDirection="column" borderStyle="round" padding={1} marginY={1}>
      <Box flexDirection="row" alignItems="center">
        <Text bold>🤖 {agentId}</Text>
        <Text dimColor> - {shortTask}</Text>
        <Spacer />
        {isRunning && <BlinkingText color="yellow">Running...</BlinkingText>}
        {!isRunning && <Text color="green">✓ Done</Text>}
      </Box>

      {expanded && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold>Task:</Text>
          </Box>
          <Box paddingLeft={1} marginTop={0}>
            <Text dimColor>{task}</Text>
          </Box>
          {completed && (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text bold>Summary:</Text>
              </Box>
              <Box paddingLeft={1} marginTop={0}>
                <Text>{completed.summary}</Text>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>
                  {completed.totalTurns} {completed.totalTurns === 1 ? 'turn' : 'turns'}, {(completed.durationMs / 1000).toFixed(1)}s
                </Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {!expanded && !isRunning && completed && (
        <Box marginTop={1}>
          <Text dimColor>
            ✓ {completed.totalTurns} {completed.totalTurns === 1 ? 'turn' : 'turns'}, {(completed.durationMs / 1000).toFixed(1)}s - press space to expand
          </Text>
        </Box>
      )}
    </Box>
  );
}