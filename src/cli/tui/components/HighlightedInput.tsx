import { Box, Text } from 'ink';
import React from 'react';

function findCursorLine(cursorOffset: number, lines: string[]): { line: number; col: number } {
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = pos + lines[i]!.length;
    if (cursorOffset <= lineEnd) {
      return { line: i, col: cursorOffset - pos };
    }
    pos = lineEnd + 1; // +1 for the \n
  }
  return { line: lines.length - 1, col: lines[lines.length - 1]!.length };
}

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
  const lines = value.split('\n');
  const { line: cursorLine, col: cursorCol } = findCursorLine(cursorOffset, lines);

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      {lines.map((line, lineIdx) => {
        let lineStart = 0;
        for (let j = 0; j < lineIdx; j++) lineStart += lines[j]!.length + 1;

        return (
          <Box key={lineIdx} flexDirection="row">
            {line.length === 0 && cursorLine === lineIdx && cursorCol === 0 ? (
              <Text inverse> </Text>
            ) : null}
            {Array.from(line).map((char, charIdx) => {
              const globalIdx = lineStart + charIdx;
              const isCursor = lineIdx === cursorLine && charIdx === cursorCol;
              const highlighted = globalIdx < highlightLength;
              return (
                <Text
                  key={`${lineIdx}-${charIdx}`}
                  bold={highlighted}
                  {...(highlighted ? { color: 'cyan' } : {})}
                  inverse={isCursor}
                >
                  {isCursor && char === ' ' ? ' ' : char}
                </Text>
              );
            })}
            {cursorLine === lineIdx && cursorCol === line.length ? (
              <Text inverse> </Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
