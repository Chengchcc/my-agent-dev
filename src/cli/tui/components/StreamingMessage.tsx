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

  // Keep the component mounted with a stable 1-line placeholder when content is
  // empty (e.g. between tool calls), so the layout doesn't jump when streaming
  // resumes. Without this, mount/unmount causes visible vertical jitter.
  if (!content) {
    return (
      <Box height={1}>
        <Text>{' '}</Text>
      </Box>
    );
  }

  // Bucket by character count: only re-parse markdown every BUCKET_SIZE chars.
  // No timers, no useDeferredValue (Ink renderer doesn't support concurrent mode).
  // The bucketBoundary is used as a memo dependency key only — we always render
  // the full content so the first <32 chars are visible.
  const bucketBoundary = Math.floor(content.length / BUCKET_SIZE) * BUCKET_SIZE;

  const elements = useMemo(
    () => renderMarkdownTokens(content),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucketBoundary],
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
