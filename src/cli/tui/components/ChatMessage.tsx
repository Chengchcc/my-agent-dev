import type { Message } from '../../../types';
import { Box, Text } from 'ink';
import { marked, type Token } from 'marked';
import React, { useMemo } from 'react';
import { useAgentLoopSelector } from '../hooks';
import { CodeBlock } from './CodeBlock';
import { ToolCallMessage } from './';

// Use require to avoid type conflicts between marked-terminal's marked types and our marked types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TerminalRenderer = require('marked-terminal').default;

// Configure marked to use TerminalRenderer
marked.setOptions({
  // @ts-ignore: TerminalRenderer type conflict due to nested dependency versions
  renderer: new TerminalRenderer(),
  async: false,
});

interface PureToolCallInfo {
  focused: boolean;
  expanded: boolean;
  pending: boolean;
  result: { content: string; isError: boolean; durationMs: number } | undefined;
}

interface PureChatMessageProps {
  message: Message;
  // For tool calls, provide the state from context - allows testing without context
  toolCallInfo?: Map<string, PureToolCallInfo>;
}

/**
 * Pure (context-free) ChatMessage component for testing
 */
export function PureChatMessage({ message, toolCallInfo = new Map() }: PureChatMessageProps) {

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
          {message.tool_calls.map(tc => {
            const info = toolCallInfo.get(tc.id) || {
              focused: false,
              expanded: false,
              pending: false,
              result: undefined,
            };
            return (
              <Box key={`${message.id ?? ''}-${tc.id}`} marginY={1}>
                <ToolCallMessage
                  toolCall={tc}
                  result={info.result ?? { content: '', isError: false, durationMs: 0 }}
                  pending={info.pending}
                  focused={info.focused}
                  expanded={info.expanded}
                />
              </Box>
            );
          })}
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
    // Connected version reads tool call state from context
    const { messages, currentTools, expandedTools, focusedToolId, toolResults } = useAgentLoopSelector(s => ({
      messages: s.messages,
      currentTools: s.currentTools,
      expandedTools: s.expandedTools,
      focusedToolId: s.focusedToolId,
      toolResults: s.toolResults,
    }));

    const toolCallInfo = useMemo(() => {
      const map = new Map<string, PureToolCallInfo>();
      if (!props.message.tool_calls) return map;

      for (const tc of props.message.tool_calls) {
        const pending = currentTools.some(t => t.toolCall.id === tc.id);
        const focused = focusedToolId === tc.id;
        const expanded = expandedTools.has(tc.id);
        const resultMeta = toolResults.get(tc.id);
        const toolMsg = messages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);

        let result: { content: string; isError: boolean; durationMs: number } | undefined;
        if (toolMsg?.content) {
          result = {
            content: toolMsg.content,
            isError: resultMeta?.isError ?? false,
            durationMs: resultMeta?.durationMs ?? 0,
          };
        }

        map.set(tc.id, { focused, expanded, pending, result });
      }
      return map;
    }, [props.message.tool_calls, currentTools, focusedToolId, expandedTools, toolResults, messages]);

    return <PureChatMessage message={props.message} toolCallInfo={toolCallInfo} />;
  },
  (prev, next) => {
    // Only re-render if what we care about actually changed
    return (
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.tool_calls === next.message.tool_calls &&
      prev.message.role === next.message.role
    );
  },
);
