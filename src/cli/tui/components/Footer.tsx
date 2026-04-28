import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoopSelector } from '../hooks';
import { clampPct } from '../utils/clamp';

interface PureFooterProps {
  totalTokens: number;
  /** tokensBucket = floor(ratio * 100). Only changes when ratio crosses 1% boundary. */
  tokensBucket: number;
  compact?: boolean;
}

/**
 * Pure (context-free) Footer. Exported unmemo'd for tests.
 */
export function PureFooter({ totalTokens, tokensBucket, compact = false }: PureFooterProps) {
  const percentage = tokensBucket;
  const clampedRatio = clampPct(percentage / 100, 1);
  const barWidth = compact ? 10 : 20;
  const filled = Math.round(barWidth * clampedRatio);
  const empty = Math.max(0, barWidth - filled);

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
      <Text dimColor>
        {compact
          ? '↑↓ hist · esc clr · /exit'
          : '↑↓ history · esc clear · ctrl+↑↓ focus · tab complete · /exit to quit'}
      </Text>
      <Box gap={1}>
        {totalTokens > 0 && (
          <>
            {!compact && <Text dimColor>Total: {totalTokens.toLocaleString()}</Text>}
            <Text dimColor>
              <Text color={status.color}>{bar}</Text> {percentage}%
              {status.label ? <Text color={status.color}> {status.label}</Text> : null}
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
}

export const PureFooterMemo = React.memo(PureFooter, (prev, next) =>
  prev.totalTokens === next.totalTokens &&
  prev.tokensBucket === next.tokensBucket &&
  prev.compact === next.compact,
);

/**
 * Connected Footer with targeted subscriptions.
 * Uses tokensBucket (0-100 integer) so Footer only re-renders when the
 * percentage crosses a 1% boundary, not on every token delta.
 */
export function Footer({ compact = false }: { compact?: boolean }) {
  const totalTokens = useAgentLoopSelector(s => s.totalUsage.totalTokens);
  const tokensBucket = useAgentLoopSelector(s => {
    const ratio = s.tokenLimit > 0 ? s.currentContextTokens / s.tokenLimit : 0;
    return Math.floor(clampPct(ratio, s.tokenLimit) * 100);
  });

  return <PureFooterMemo totalTokens={totalTokens} tokensBucket={tokensBucket} compact={compact} />;
}
