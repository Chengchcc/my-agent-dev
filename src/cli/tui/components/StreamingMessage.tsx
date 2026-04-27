import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { renderMarkdownTokens } from './utils/render-markdown';

interface StreamingMessageProps {
  content: string;
}

/**
 * Streaming message component with throttled incremental markdown rendering.
 * Uses a ~50ms throttle to avoid re-parsing markdown on every text delta,
 * while still providing syntax-highlighted output during streaming.
 */
export function StreamingMessage({ content }: StreamingMessageProps) {
  const latestRef = useRef(content);
  const [renderedContent, setRenderedContent] = useState(content);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = content;

    if (timerRef.current) return; // throttle already pending

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setRenderedContent(latestRef.current);
    }, 50);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [content]);

  const elements = useMemo(() => renderMarkdownTokens(renderedContent), [renderedContent]);

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
