import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { countTokens } from '@anthropic-ai/tokenizer';

interface ThinkingMessageProps {
  content: string;
  /** Whether the thinking is being streamed (animate) */
  streaming?: boolean;
  /** Whether the thinking block is collapsed */
  collapsed?: boolean;
}

export function ThinkingMessage({ content, streaming, collapsed = false }: ThinkingMessageProps) {
  if (!content) return null;

  const tokenCount = useMemo(() => {
    try { return countTokens(content); } catch { return Math.ceil(content.length / 4); }
  }, [content]);

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
