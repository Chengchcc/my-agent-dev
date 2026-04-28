import React, { useDeferredValue, useMemo } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdownTokens } from './utils/render-markdown';
import { debugLog } from '../../../utils/debug';

interface StreamingMessageProps {
  content: string;
}

/**
 * Streaming message with deferred markdown rendering.
 * useDeferredValue keeps the previous content during rapid text deltas
 * so markdown is only re-parsed when React has idle time between updates.
 */
export function StreamingMessage({ content }: StreamingMessageProps) {
  debugLog('[render] StreamingMessage', { len: content.length, preview: content.slice(0, 200) });

  const deferredContent = useDeferredValue(content);
  const elements = useMemo(() => renderMarkdownTokens(deferredContent), [deferredContent]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{'<'} </Text>
        <Text color="cyan">assistant:</Text>
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {elements}
      </Box>
    </Box>
  );
}
