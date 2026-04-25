import { Box, Text } from 'ink';
import Prism from 'prismjs';
import React, { useMemo } from 'react';
import chalk from 'chalk';
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
import { getCachedTokens, setCachedTokens } from '../utils/syntax-cache';

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
    const cached = getCachedTokens(content, lang);
    if (cached) return cached;

    const lines =
      lang === 'text' || !Prism.languages[lang]
        ? content.split('\n').map(line => [{ content: line, type: null }])
        : tokenizeByLine(Prism.tokenize(content, Prism.languages[lang]));

    setCachedTokens(content, lang, lines);
    return lines;
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
        const gutter = `${String(currentLineNumber).padStart(gutterWidth, ' ')} │ `;

        // Build ANSI-colored string for the entire line in JS
        // This reduces Yoga node count from ~10,000 to ~500 for large files
        let lineContent = '';
        for (const token of lineTokens) {
          const colorName = token.type ? (theme[token.type] ?? 'white') : 'white';
          const colorFn = (chalk as unknown as Record<string, ((s: string) => string) | undefined>)[colorName];
          if (colorFn) {
            lineContent += colorFn(token.content);
          } else {
            lineContent += token.content;
          }
        }

        return (
          <Box key={index} flexDirection="row">
            <Text color="dim">{gutter}</Text>
            <Text>{lineContent}</Text>
          </Box>
        );
      })}
      {truncated && (
        <Text color="dim">... │ ...</Text>
      )}
    </Box>
  );
}

