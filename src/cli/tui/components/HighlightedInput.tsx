import { Box, Text } from 'ink';
import React from 'react';

export function HighlightedInput({
  value,
  cursorOffset,
  placeholder,
  highlightedCommandName,
}: {
  value: string;
  cursorOffset: number;
  placeholder: string;
  highlightedCommandName?: string | null;
}) {
  if (value.length === 0) {
    return (
      <Box width="100%">
        <Text>
          {placeholder.length > 0 && (
            <>
              <Text inverse dimColor>
                {placeholder[0] ?? ' '}
              </Text>
              <Text dimColor>{placeholder.slice(1)}</Text>
            </>
          )}
        </Text>
      </Box>
    );
  }

  const highlightLength = highlightedCommandName ? highlightedCommandName.length + 1 : 0;

  // All characters are individual inline Text components for correct styling
  // Outer Box handles layout, no outer Text needed to avoid unexpected wrapping
  return (
    <Box flexGrow={1} flexShrink={1}>
        {value.split('').map((char, index) => {
          const isCursor = index === cursorOffset;
          const highlighted = index < highlightLength;
          return (
            <Text
              key={`${char}-${index}`}
              bold={highlighted}
              color={highlighted ? 'cyan' : undefined}
              inverse={isCursor}
            >
              {isCursor && char === ' ' ? ' ' : char}
            </Text>
          );
        })}
        {cursorOffset === value.length ? <Text inverse>{' '}</Text> : null}
    </Box>
  );
}
