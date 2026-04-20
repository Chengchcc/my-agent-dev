import { Box, Text } from 'ink';
import { marked } from 'marked';
import React from 'react';
import type { Message } from '../../../types';
import { CodeBlock } from './CodeBlock';

interface Tokens {
  type: string;
  text?: string;
  tokens?: Tokens[];
  items?: Tokens[];
  lang?: string;
}

export function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  const renderer = new marked.Renderer();
  const elements: React.ReactNode[] = [];

  const tokens = marked.lexer(message.content);

  (tokens as any[]).forEach((token: any, index: number) => {
    switch (token.type) {
      case 'heading': {
        const level = token.depth;
        elements.push(
          <Box key={index} marginTop={level > 1 ? 1 : 0}>
            <Text bold color="cyan">
              {'#'.repeat(level)} {token.text}
            </Text>
          </Box>,
        );
        break;
      }
      case 'paragraph': {
        elements.push(
          <Box key={index} marginY={1}>
            <Text color={isUser ? 'white' : 'white'}>
              {renderText(token.tokens)}
            </Text>
          </Box>,
        );
        break;
      }
      case 'code': {
        elements.push(<CodeBlock key={index} code={token.text} language={token.lang} />);
        break;
      }
      case 'list': {
        // Simple list rendering
        token.items.forEach((item: any, itemIndex: number) => {
          elements.push(
            <Box key={`${index}-${itemIndex}`} paddingLeft={2}>
              <Text>
                • {renderText(item.tokens)}
              </Text>
            </Box>,
          );
        });
        break;
      }
      case 'text':
      default: {
        if (token.text) {
          elements.push(
            <Text key={index} color="white">
              {token.text}
            </Text>,
          );
        }
      }
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={isUser ? 'blue' : 'green'}>
          {isUser ? '>' : '<'} {message.role}:
        </Text>
      </Box>
      <Box paddingLeft={1}>
        {elements}
      </Box>
    </Box>
  );
}

function renderText(tokens?: any[]): string {
  if (!tokens) return '';
  return tokens.map(t => t.text || '').join('');
}