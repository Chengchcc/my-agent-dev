import { Box, Text } from 'ink';
import Prism from 'prismjs';
import React, { useMemo } from 'react';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-css';
import { tokenizeByLine } from './utils/tokenize-by-line';
import { getLanguageFromFilePath } from './utils/language-map';

type DiffLineType = 'added' | 'removed' | 'context';

interface DiffLine {
  type: DiffLineType;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: string;
  tokens?: Array<{ content: string; type?: string }>;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

interface DiffViewProps {
  filePath: string;
  diff: { hunks: DiffHunk[] };
  language?: string;
  context?: number;
}

const theme: Record<string, string> = {
  comment: 'gray',
  prolog: 'gray',
  doctype: 'gray',
  cdata: 'gray',
  punctuation: 'gray',
  property: 'cyan',
  keyword: 'blue',
  boolean: 'yellow',
  number: 'yellow',
  constant: 'cyan',
  symbol: 'green',
  selector: 'green',
  'attr-name': 'green',
  string: 'green',
  builtin: 'cyan',
  inserted: 'green',
  operator: 'gray',
  entity: 'white',
  url: 'cyan',
  variable: 'white',
  atrule: 'yellow',
  'attr-value': 'yellow',
  placeholder: 'yellow',
  deleted: 'red',
  italic: 'italic',
  important: 'bold',
  bold: 'bold',
  heading: 'blue',
  function: 'blue',
  'class-name': 'yellow',
  'tag': 'blue',
};

function getTokenColor(type?: string): string {
  return type ? (theme[type] ?? 'white') : 'white';
}

export function DiffView({ filePath, diff, language }: DiffViewProps) {
  const hunks = diff.hunks || [];

  const stats = useMemo(() => {
    let added = 0;
    let removed = 0;

    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'added') added++;
        if (line.type === 'removed') removed++;
      }
    }

    return { added, removed };
  }, [hunks]);

  const lang = language || getLanguageFromFilePath(filePath) || 'text';
  const hasSyntaxHighlighting = lang !== 'text' && !!Prism.languages[lang];

  // Pre-tokenize all context lines for syntax highlighting
  const tokenizedHunks = useMemo(() => {
    if (!hasSyntaxHighlighting) {
      return hunks;
    }

    return hunks.map(hunk => {
      // Tokenize all lines regardless of type for consistent syntax highlighting
      const allContent = hunk.lines.map(line => line.content).join('\n');
      const tokens = Prism.tokenize(allContent, Prism.languages[lang]!);

      const tokenizedLines = tokenizeByLine(tokens);

      // Map tokenized lines back to hunk
      return {
        ...hunk,
        lines: hunk.lines.map((line, index) => {
          return {
            ...line,
            tokens: tokenizedLines[index],
          };
        }),
      };
    });
  }, [hunks, lang, hasSyntaxHighlighting]);

  return (
    <Box marginY={1} flexDirection="column">
      <Text color="cyan">
        ── {filePath} (diff:{' '}
        <Text color="green">+{stats.added}</Text>{' '}
        <Text color="red">-{stats.removed}</Text>
        ) ──
      </Text>

      {tokenizedHunks.map((hunk, hunkIndex) => (
        <Box key={hunkIndex} flexDirection="column" marginY={1}>
          <Text color="cyan">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </Text>

          {hunk.lines.map((line, lineIndex) => {
            const oldLineNum = line.oldLineNumber?.toString().padStart(4, ' ') ?? '    ';
            const newLineNum = line.newLineNumber?.toString().padStart(4, ' ') ?? '    ';

            let marker = ' ';
            let color = 'white';
            let strikethrough = false;

            if (line.type === 'added') {
              marker = '+';
              color = 'green';
            } else if (line.type === 'removed') {
              marker = '-';
              color = 'red';
              strikethrough = true;
            }

            return (
              <Box key={lineIndex} flexDirection="row">
                <Text color="dim">{oldLineNum}</Text>
                <Text color="dim"> {newLineNum}</Text>
                <Text color="dim"> {marker}</Text>

                {line.tokens ? (
                  <Box flexDirection="row">
                    {line.tokens.map((token: { content: string; type?: string }, tokenIndex: number) => (
                      <Text
                        key={tokenIndex}
                        color={getTokenColor(token.type) || color}
                        strikethrough={strikethrough}
                      >
                        {token.content}
                      </Text>
                    ))}
                  </Box>
                ) : (
                  <Text color={color} strikethrough={strikethrough}>
                    {line.content}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

