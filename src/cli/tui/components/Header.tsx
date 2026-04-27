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
  status?: 'connected' | 'interrupted' | 'reconnecting';
  compact?: boolean;
}

const STATUS_DOTS: Record<string, { char: string; color: string; label: string }> = {
  connected:    { char: '\u25CF', color: 'green',  label: 'connected' },
  interrupted:  { char: '\u25CB', color: 'red',    label: 'interrupted' },
  reconnecting: { char: '\u25D0', color: 'yellow', label: 'reconnecting' },
};

/**
 * Pure (context-free) Header component for testing
 */
export function PureHeader({ model, sessionId, status = 'connected', compact = false }: PureHeaderProps) {
  const st = STATUS_DOTS[status]!;

  return (
    <Box flexDirection="row" alignItems="center" gap={1} width="100%" justifyContent="space-between">
      <Box flexDirection="row" alignItems="center" gap={1}>
        {!compact && <Text>{HAMSTER_LOGO}</Text>}
        <Text>
          <Text bold color="cyan">my-agent</Text>
          {model && !compact && <Text dimColor> \u00B7 {model}</Text>}
          <Text dimColor> \u00B7 </Text>
          <Text color={st.color}>{st.char}</Text>
          {!compact && <Text dimColor> {st.label}</Text>}
        </Text>
      </Box>
      {sessionId && !compact && <Text dimColor>session:{sessionId.slice(0, 8)}</Text>}
    </Box>
  );
}

/**
 * Connected Header that reads state from context
 */
export function Header({ sessionStore, compact = false }: { sessionStore: SessionStore; compact?: boolean }) {
  const { agent, interrupted } = useAgentLoop();
  const model = agent.getModelName();
  const sessionId = sessionStore.getSessionId();
  const status = interrupted ? 'interrupted' as const : 'connected' as const;
  return <PureHeader model={model} sessionId={sessionId} status={status} compact={compact} />;
}
