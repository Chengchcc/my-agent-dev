import { Box, Text } from 'ink';
import { marked, type Token } from 'marked';
import React, { useMemo } from 'react';
import type { Message } from '../../../types';
import { CodeBlock } from './CodeBlock';

// Use require to avoid type conflicts between marked-terminal's marked types and our marked types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default;

// Configure marked to use TerminalRenderer for non-code content
// We still handle code blocks separately for proper Ink syntax highlighting
marked.setOptions({
  // @ts-ignore: TerminalRenderer type conflict due to nested dependency versions
  renderer: new TerminalRenderer(),
  async: false,
});

export function ChatMessage({ message }: { message: Message }) {
  // Handle different role types with appropriate styling
  const getRoleColor = (role: string): string => {
    switch (role) {
      case 'user':
        return 'blue';
      case 'assistant':
        return 'green';
      case 'system':
        return 'yellow';
      case 'tool':
        return 'magenta';
      default:
        return 'gray';
    }
  };

  const getRolePrefix = (role: string): string => {
    switch (role) {
      case 'user':
        return '>';
      case 'assistant':
        return '<';
      case 'system':
        return '*';
      case 'tool':
        return '#';
      default:
        return '?';
    }
  };

  const roleColor = getRoleColor(message.role);
  const rolePrefix = getRolePrefix(message.role);

  // Check if the message contains code blocks that need syntax highlighting
  // If it just has simple markdown content, use marked-terminal for quick rendering
  // If there are code blocks, we still need to process them manually for proper highlighting
  const hasCodeBlocks = /```[\s\S]*```/.test(message.content);

  const rendered = useMemo(() => {
    if (!hasCodeBlocks) {
      // No code blocks - use marked-terminal directly
      // marked can return promise if async is enabled, but we disabled async above
      try {
        const result = marked(message.content) as string;
        return result.trimEnd();
      } catch (e) {
        // If markdown parsing fails, fall back to raw text
        console.warn('Markdown parsing failed, falling back to raw text:', e);
        return message.content;
      }
    }
    return null;
  }, [message.content, hasCodeBlocks]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor}>
          {rolePrefix} {message.role}:
        </Text>
      </Box>
      <Box paddingLeft={1}>
        {rendered !== null ? (
          <Text>{rendered}</Text>
        ) : (
          // When there are code blocks, we need to process manually to get proper highlighting
          // This follows the same approach but keeps our custom CodeBlock component
          <ChatMessageContent content={message.content} />
        )}
      </Box>
    </Box>
  );
}

/**
 * Manual processing when message contains code blocks that need syntax highlighting.
 */
function ChatMessageContent({ content }: { content: string }) {
  const elements: React.ReactNode[] = [];

  try {
    const tokens = marked.lexer(content);

    tokens.forEach((token, index) => {
      if (token.type === 'code') {
        const codeToken = token as Token & { text: string; lang?: string };
        elements.push(<CodeBlock key={index} code={codeToken.text} language={codeToken.lang} />);
      } else {
        // Other tokens are already handled by marked-lexer and we can render via marked-terminal
        // Collect into a single string and let marked-terminal do its thing
        // This gives us proper ANSI styling that Ink can handle
        const tokenContent = getTokenContent(token);
        if (tokenContent.trim()) {
          try {
            const result = marked(tokenContent) as string;
            elements.push(
              <Text key={index}>
                {result.trimEnd()}
              </Text>,
            );
          } catch (e) {
            // If parsing this token fails, output raw text
            console.warn(`Marked parsing failed for token at index ${index}, falling back to raw text:`, e);
            elements.push(
              <Text key={index}>
                {tokenContent}
              </Text>,
            );
          }
        }
      }
    });
  } catch (e) {
    // If overall lexing/parsing fails, fall back to full raw text
    console.warn('Marked lexing failed, falling back to full raw text:', e);
    elements.push(<Text>{content}</Text>);
  }

  return <>{elements}</>;
}

function getTokenContent(token: Token): string {
  if ('text' in token) {
    return token.text || '';
  }
  return '';
}
