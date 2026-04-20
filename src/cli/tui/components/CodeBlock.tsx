import { Box, Text } from 'ink';
import Prism from 'prismjs';
import React from 'react';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-diff';

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
};

const languageNames: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
};

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const lang = language ? (languageNames[language] ?? language) : 'text';
  const highlighted = lang !== 'text' && Prism.languages[lang]
    ? Prism.highlight(code, Prism.languages[lang], lang)
    : code;

  // Split into tokens and render with colors
  const tokens = splitTokens(highlighted, lang);

  return (
    <Box marginY={1} paddingLeft={1}>
      <Text>
        {tokens.map((token, index) => (
          <Text key={index} color={token.type ? theme[token.type] : 'white'}>
            {token.content}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function splitTokens(html: string, lang: string): Array<{ content: string; type?: string }> {
  // Simple parser for the Prism span output
  const result: Array<{ content: string; type?: string }> = [];
  const regex = /<span class="token ([^"]+)">(.*?)<\/span>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      result.push({ content: html.slice(lastIndex, match.index) });
    }
    result.push({ content: match[2], type: match[1].split(' ')[0] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < html.length) {
    result.push({ content: html.slice(lastIndex) });
  }

  return result;
}