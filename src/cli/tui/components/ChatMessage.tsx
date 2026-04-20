import { Box, Text } from 'ink';
import { marked } from 'marked';
import React from 'react';
import type { Message } from '../../../types';
import type { Token } from 'marked';
import { CodeBlock } from './CodeBlock';

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
  const elements: React.ReactNode[] = [];

  const tokens = marked.lexer(message.content);

  (tokens as Token[]).forEach((token: Token, index: number) => {
    switch (token.type) {
      case 'heading': {
        const headingToken = token as Token & { depth: number; text: string };
        const level = headingToken.depth;
        elements.push(
          <Box key={index} marginTop={level > 1 ? 1 : 0}>
            <Text bold color="cyan">
              {`${'#'.repeat(level)} ${headingToken.text}`}
            </Text>
          </Box>,
        );
        break;
      }
      case 'paragraph': {
        const paragraphToken = token as Token & { tokens: Token[] };
        elements.push(
          <Box key={index} marginY={1}>
            <Text color="white">
              {renderInlineTokens(paragraphToken.tokens)}
            </Text>
          </Box>,
        );
        break;
      }
      case 'code': {
        const codeToken = token as Token & { text: string; lang?: string };
        elements.push(<CodeBlock key={index} code={codeToken.text} language={codeToken.lang} />);
        break;
      }
      case 'list': {
        const listToken = token as Token & { items: Array<{ tokens?: Token[] }> };
        // Process each list item with full inline token processing
        listToken.items.forEach((item: { tokens?: Token[] }, itemIndex: number) => {
          elements.push(
            <Box key={`${index}-${itemIndex}`} paddingLeft={2}>
              <Text color="white">
                • {renderInlineTokens(item.tokens)}
              </Text>
            </Box>,
          );
        });
        break;
      }
      case 'text':
      default: {
        const textToken = token as Token & { text?: string; tokens?: Token[] };
        if (textToken.text) {
          elements.push(
            <Text key={index} color="white">
              {textToken.tokens ? renderInlineTokens(textToken.tokens) : textToken.text}
            </Text>,
          );
        }
      }
    }
  });

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor}>
          {rolePrefix} {message.role}:
        </Text>
      </Box>
      <Box paddingLeft={1}>
        {elements}
      </Box>
    </Box>
  );
}

/**
 * Render inline tokens with proper styling for bold, italic, code, etc.
 */
function renderInlineTokens(tokens?: (Token | string)[]): React.ReactNode[] {
  if (!tokens || !Array.isArray(tokens)) return [];

  return tokens.map((token, index): React.ReactNode => {
    if (typeof token === 'string') {
      return <React.Fragment key={index}>{token}</React.Fragment>;
    }

    // Handle different inline token types with appropriate Ink styles
    // Narrow the type based on token properties
    switch (token.type) {
      case 'strong':
      case 'bold': {
        const boldToken = token as Token & { tokens: (Token | string)[] };
        return (
          <Text key={index} bold>
            {renderInlineTokens(boldToken.tokens)}
          </Text>
        );
      }
      case 'em':
      case 'italic': {
        const italicToken = token as Token & { tokens: (Token | string)[] };
        return (
          <Text key={index} italic>
            {renderInlineTokens(italicToken.tokens)}
          </Text>
        );
      }
      case 'codespan':
      case 'code': {
        const codeToken = token as Token & { text: string };
        return (
          <Text key={index} color="cyan">
            {codeToken.text}
          </Text>
        );
      }
      case 'link': {
        const linkToken = token as Token & { text: string };
        return (
          <Text key={index} color="blue" underline>
            {linkToken.text}
          </Text>
        );
      }
      case 'image': {
        const imageToken = token as Token & { text: string };
        return (
          <Text key={index} color="magenta" italic>
            ![{imageToken.text}]
          </Text>
        );
      }
      case 'del':
      case 'strikethrough': {
        const delToken = token as Token & { tokens: (Token | string)[] };
        return (
          <Text key={index} strikethrough>
            {renderInlineTokens(delToken.tokens)}
          </Text>
        );
      }
      case 'text':
      default: {
        const textToken = token as Token & { tokens?: (Token | string)[]; text?: string };
        // If the token has nested tokens, recursively render them
        if (textToken.tokens) {
          return <React.Fragment key={index}>{renderInlineTokens(textToken.tokens)}</React.Fragment>;
        }
        // Otherwise just render the text
        return <React.Fragment key={index}>{textToken.text ?? ''}</React.Fragment>;
      }
    }
  });
}
