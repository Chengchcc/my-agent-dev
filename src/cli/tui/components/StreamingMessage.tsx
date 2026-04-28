import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdownTokens } from './utils/render-markdown';
import { debugLog } from '../../../utils/debug';

interface StreamingMessageProps {
  content: string;
}

const BUCKET_SIZE = 32;

/**
 * Streaming message with character-bucket rendering.
 * Only re-parses markdown every BUCKET_SIZE characters to avoid
 * overwhelming the React render cycle during rapid text streaming.
 */
export function StreamingMessage({ content }: StreamingMessageProps) {
  debugLog('[render] StreamingMessage', { len: content.length, preview: content.slice(0, 200) });

  // Bucket by character count: only update rendered content every N chars.
  // No timers, no useDeferredValue (Ink renderer doesn't support concurrent mode).
  const bucketBoundary = Math.floor(content.length / BUCKET_SIZE) * BUCKET_SIZE;
  const renderedContent = content.slice(0, bucketBoundary);

  const elements = useMemo(
    () => renderMarkdownTokens(renderedContent),
    [renderedContent],
  );

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
