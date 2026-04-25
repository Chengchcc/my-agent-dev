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

interface PureHeaderProps {
  model: string;
  sessionId: string | null;
}

/**
 * Pure (context-free) Header component for testing
 */
export function PureHeader({ model, sessionId }: PureHeaderProps) {
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

/**
 * Connected Header that reads state from context
 */
export function Header({ sessionStore }: { sessionStore: SessionStore }) {
  const { agent } = useAgentLoop();
  const model = agent.getModelName();
  const sessionId = sessionStore.getSessionId();
  return <PureHeader model={model} sessionId={sessionId} />;
}
