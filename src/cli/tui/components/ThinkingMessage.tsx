import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { countTokens } from '@anthropic-ai/tokenizer';
import { debugLog } from '../../../utils/debug';

interface ThinkingMessageProps {
  content: string;
  /** Whether the thinking is being streamed (animate) */
  streaming?: boolean;
  /** Whether the thinking block is collapsed */
  collapsed?: boolean;
}

export function ThinkingMessage({ content, streaming, collapsed = false }: ThinkingMessageProps) {
  debugLog('[render] ThinkingMessage', { hasContent: !!content, streaming, collapsed });
  const tokenCount = useMemo(() => {
    if (!content) return 0;
    try { return countTokens(content); } catch { return Math.ceil(content.length / 4); }
  }, [content]);

  if (!content) return null;

  if (collapsed) {
    return (
      <Box marginLeft={1}>
        <Text dimColor>{'\u25B6'} Thinking ({tokenCount.toLocaleString()} tokens) — Ctrl+T to expand</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Text dimColor italic>
        {streaming ? 'Thinking...' : 'Thought process'}
      </Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{content}</Text>
      </Box>
    </Box>
  );
}
