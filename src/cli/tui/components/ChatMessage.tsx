import type { Message } from '../../../types';
import { Box, Text } from 'ink';
import { marked, type Token } from 'marked';
import React, { useMemo } from 'react';
import { CodeBlock } from './CodeBlock';
import { ToolCallMessage, ConnectedToolCallMessage } from './ToolCallMessage';

// Use require to avoid type conflicts between marked-terminal's marked types and our marked types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default;

// Configure marked to use TerminalRenderer
marked.setOptions({
  // @ts-ignore: TerminalRenderer type conflict due to nested dependency versions
  renderer: new TerminalRenderer(),
  async: false,
});

interface PureChatMessageProps {
  message: Message;
  /** Override the tool call renderer — defaults to pure ToolCallMessage (no context required, for testing) */
  ToolCallComponent?: React.ComponentType<{ toolCall: import('../../../types').ToolCall }>;
}

/**
 * Pure (context-free) ChatMessage component for testing.
 * Defaults to pure ToolCallMessage. ChatMessage overrides with ConnectedToolCallMessage.
 */
export function PureChatMessage({ message, ToolCallComponent = ToolCallMessage }: PureChatMessageProps) {

  // Handle different role types with appropriate styling
  const getRoleColor = (role: string): string => {
    switch (role) {
      case 'user':
        return 'cyan';      // Nord cyan for user input
      case 'assistant':
        return 'white';     // Light gray/white for assistant output
      case 'system':
        return 'yellow';    // Muted yellow for system messages
      case 'tool':
        return 'magenta';   // Muted purple for tool output
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

  function renderMarkdownTokens(content: string): React.ReactNode[] {
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
            } catch (e) {
              console.warn(`Marked parsing failed for buffered text, falling back to raw text:`, e);
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
        } catch (e) {
          console.warn('Marked parsing failed for final buffer, falling back to raw text:', e);
          elements.push(
            <Text key="final">
              {textBuffer}
            </Text>,
          );
        }
      }
    } catch (e) {
      console.warn('Marked lexing failed, falling back to full raw text:', e);
      elements.push(<Text>{content}</Text>);
    }

    return elements;
  }

  const roleColor = getRoleColor(message.role);
  const rolePrefix = getRolePrefix(message.role);
  const elements = useMemo(() => renderMarkdownTokens(message.content ?? ''), [message.content]);

  // Assistant messages with tool calls: render content + inline tool calls
  if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={roleColor}>
            {rolePrefix} {message.role}:
          </Text>
        </Box>
        <Box paddingLeft={1} flexDirection="column">
          {message.content && (
            <Box flexDirection="column">
              {elements}
            </Box>
          )}
          {message.tool_calls.map(tc => (
            <Box key={`${message.id ?? ''}-${tc.id}`} marginY={1}>
              <ToolCallComponent toolCall={tc} />
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  // Don't render standalone tool messages - they're rendered inline with the assistant message
  // Don't render system messages in the chat history (they provide instructions to the model, not visible to the user)
  if (message.role === 'tool' || message.role === 'system') {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor}>
          {rolePrefix} {message.role}:
        </Text>
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {elements}
      </Box>
    </Box>
  );
}

export const ChatMessage = React.memo(
  (props: { message: Message }) => {
    return <PureChatMessage message={props.message} ToolCallComponent={ConnectedToolCallMessage} />;
  },
  (prev, next) => {
    return (
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.tool_calls === next.message.tool_calls &&
      prev.message.role === next.message.role
    );
  },
);
