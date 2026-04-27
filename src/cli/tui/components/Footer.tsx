import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';
import { clampPct } from '../utils/clamp';

interface PureFooterProps {
  totalUsage: { totalTokens: number };
  currentContextTokens: number;
  tokenLimit: number;
}

/**
 * Pure (context-free) Footer component for testing
 */
export function PureFooter({ totalUsage, currentContextTokens, tokenLimit }: PureFooterProps) {
  const clampedRatio = clampPct(currentContextTokens, tokenLimit);
  const percentage = Math.round(clampedRatio * 100);
  const barWidth = 20;
  const filled = Math.round(barWidth * clampedRatio);
  const empty = Math.max(0, barWidth - filled);

  // Get budget status label and color
  function getBudgetStatus(percent: number): { label: string; color: 'gray' | 'cyan' | 'yellow' | 'red' } {
    if (percent >= 90) return { label: 'CRITICAL', color: 'red' };
    if (percent >= 85) return { label: 'WARNING', color: 'yellow' };
    if (percent >= 70) return { label: 'NOTICE', color: 'cyan' };
    return { label: '', color: 'gray' };
  }

  const status = getBudgetStatus(percentage);
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  return (
    <Box marginTop={1} width="100%" justifyContent="space-between">
      <Text dimColor>Type /exit to quit, /clear to clear conversation</Text>
      <Box gap={1}>
        {totalUsage.totalTokens > 0 && (
          <>
            <Text dimColor>Total: {totalUsage.totalTokens.toLocaleString()}</Text>
            <Text dimColor>
              Context: <Text color={status.color}>{bar}</Text> {percentage}%
              {status.label && <Text color={status.color}> {status.label}</Text>}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

/**
 * Connected Footer that reads state from AgentLoopContext
 */
export function Footer() {
  const { totalUsage, currentContextTokens, tokenLimit } = useAgentLoop();
  return <PureFooter
    totalUsage={totalUsage}
    currentContextTokens={currentContextTokens}
    tokenLimit={tokenLimit}
  />;
}
