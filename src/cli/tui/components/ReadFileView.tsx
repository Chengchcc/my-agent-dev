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
import 'prismjs/components/prism-diff';
import { DiffView, type DiffHunk } from './DiffView';
import { tokenizeByLine } from './utils/tokenize-by-line';
import { getLanguageFromFilePath } from './utils/language-map';

interface ReadFileViewProps {
  filePath: string;
  content: string;
  startLine: number;
  totalFileLines?: number;
  language?: string;
  maxHeight?: number;
  diff?: { hunks: DiffHunk[] };
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

export function ReadFileView({
  filePath,
  content,
  startLine,
  totalFileLines,
  language,
  maxHeight = 50,
  diff,
}: ReadFileViewProps) {
  const lang = language || getLanguageFromFilePath(filePath) || 'text';

  const highlightedLines = useMemo(() => {
    if (lang === 'text' || !Prism.languages[lang]) {
      return content.split('\n').map(line => [{ content: line }]);
    }

    const tokens = Prism.tokenize(content, Prism.languages[lang]);
    return tokenizeByLine(tokens);
  }, [content, lang]);

  // If diff is provided, render it with DiffView
  if (diff) {
    return <DiffView filePath={filePath} diff={diff} language={lang} />;
  }

  const linesToShow = highlightedLines.slice(0, maxHeight);
  const truncated = highlightedLines.length > maxHeight;

  // Determine the width of the gutter based on last displayed line (accounts for truncation)
  const lastDisplayedLine = truncated
    ? startLine + maxHeight - 1
    : (totalFileLines || startLine + highlightedLines.length - 1);
  const gutterWidth = String(lastDisplayedLine).length;

  const header = `── ${filePath} (${totalFileLines ? `lines ${startLine}-${startLine + linesToShow.length - 1} of ${totalFileLines}` : 'all lines'}, ${lang}) ──`;

  return (
    <Box marginY={1} flexDirection="column">
      <Text color="cyan">{header}</Text>
      {linesToShow.map((lineTokens, index) => {
        const currentLineNumber = startLine + index;
        return (
          <Box key={index} flexDirection="row">
            <Text color="dim">
              {String(currentLineNumber).padStart(gutterWidth, ' ')}
            </Text>
            <Text color="dim"> │ </Text>
            <Box flexDirection="row">
              {lineTokens.map((token: { content: string; type?: string }, tokenIndex: number) => {
                const color = token.type ? (theme[token.type] ?? 'white') : 'white';
                return (
                  <Text key={tokenIndex} color={color}>
                    {token.content}
                  </Text>
                );
              })}
            </Box>
          </Box>
        );
      })}
      {truncated && (
        <Text color="dim">... │ ...</Text>
      )}
    </Box>
  );
}

