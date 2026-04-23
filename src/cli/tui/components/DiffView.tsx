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
import { inferLanguage } from './utils/language-map';

export type DiffLineType = 'added' | 'removed' | 'context';

export interface DiffLine {
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

export interface DiffViewProps {
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

export function DiffView({ filePath, diff, language, context }: DiffViewProps) {
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

  const lang = language || inferLanguage(filePath) || 'text';
  const hasSyntaxHighlighting = lang !== 'text' && !!Prism.languages[lang];

  // Pre-tokenize all context lines for syntax highlighting
  const tokenizedHunks = useMemo(() => {
    if (!hasSyntaxHighlighting) {
      return hunks;
    }

    return hunks.map(hunk => {
      const contextLines = hunk.lines
        .filter(line => line.type === 'context')
        .map(line => line.content);

      const contextText = contextLines.join('\n');
      const tokens = Prism.tokenize(contextText, Prism.languages[lang]);

      const lineLengths = contextLines.map(line => line.length);
      const tokenizedLines = tokenizeByLine(tokens, lineLengths);

      // Map tokenized lines back to hunk
      const lineMap = new Map<string, any[]>();
      contextLines.forEach((line, index) => {
        lineMap.set(line, tokenizedLines[index]);
      });

      return {
        ...hunk,
        lines: hunk.lines.map(line => {
          if (line.type === 'context' && lineMap.has(line.content)) {
            return {
              ...line,
              tokens: lineMap.get(line.content),
            };
          }
          return line;
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

                {line.type === 'context' && line.tokens ? (
                  <Box flexDirection="row">
                    {line.tokens.map((token: { content: string; type?: string }, tokenIndex: number) => (
                      <Text
                        key={tokenIndex}
                        color={getTokenColor(token.type)}
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

export default DiffView;
