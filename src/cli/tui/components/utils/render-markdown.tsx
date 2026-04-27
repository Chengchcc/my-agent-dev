import { Text } from 'ink';
import { marked, type Token } from 'marked';
import React from 'react';
import { CodeBlock } from '../CodeBlock';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default;

let markedConfigured = false;
if (!markedConfigured) {
  markedConfigured = true;
  marked.setOptions({
    // @ts-ignore: TerminalRenderer type conflict due to nested dependency versions
    renderer: new TerminalRenderer(),
    async: false,
  });
}

export function renderMarkdownTokens(content: string): React.ReactNode[] {
  const elements: React.ReactNode[] = [];
  let textBuffer = '';

  try {
    const tokens = marked.lexer(content);

    tokens.forEach((token, index) => {
      if (token.type === 'code') {
        if (textBuffer.trim()) {
          try {
            const result = marked(textBuffer) as string;
            elements.push(
              <Text key={`buffer-${index}`}>
                {result.trimEnd()}
              </Text>,
            );
          } catch {
            elements.push(
              <Text key={`buffer-${index}`}>
                {textBuffer}
              </Text>,
            );
          }
          textBuffer = '';
        }
        const codeToken = token as Token & { text: string; lang?: string };
        const codeBlockProps: any = { key: index, code: codeToken.text };
        if (codeToken.lang) codeBlockProps.language = codeToken.lang;
        elements.push(<CodeBlock {...codeBlockProps} />);
      } else {
        const tokenAny = token as any;
        if (tokenAny.raw) {
          textBuffer += tokenAny.raw;
        } else if (tokenAny.text) {
          textBuffer += tokenAny.text;
        }
      }
    });

    if (textBuffer.trim()) {
      try {
        const result = marked(textBuffer) as string;
        elements.push(
          <Text key="final">
            {result.trimEnd()}
          </Text>,
        );
      } catch {
        elements.push(
          <Text key="final">
            {textBuffer}
          </Text>,
        );
      }
    }
  } catch {
    elements.push(<Text>{content}</Text>);
  }

  return elements;
}
