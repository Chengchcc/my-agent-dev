import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks/use-agent-loop';
import type { SessionStore } from '../../../session/store';

// ASCII hamster logo for the TUI header
const HAMSTER_LOGO = `\
▄█▄█▄
█●█●█
▀███▀
 █ █`;

export function Header({ sessionStore }: { sessionStore: SessionStore }) {
  const { agent } = useAgentLoop();

  // Get model from config if available
  const model = agent.config.model;
  const sessionId = sessionStore.getSessionId();

  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text>{HAMSTER_LOGO}</Text>
        <Text>
          <Text bold color="cyan">my-agent</Text>
          {model && <Text dimColor> ({model})</Text>}
        </Text>
      </Box>
      {sessionId && <Text dimColor>Session: {sessionId.slice(0, 8)}</Text>}
    </Box>
  );
}
