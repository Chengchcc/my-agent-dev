import { Box, Text } from 'ink';
import { marked, type Token } from 'marked';
import React, { useMemo } from 'react';
import { useAgentLoop } from '../hooks';
import type { Message } from '../../../types';
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

export function ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const { focusedToolId, expandedTools, toolResults, currentTools, messages: allMessages } = useAgentLoop();

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

  // Split content into stable part (fully closed markdown structures) and pending part (unclosed)
  function splitStableContent(content: string): { stable: string; pending: string } {
    if (!isStreaming) {
      return { stable: content, pending: '' };
    }

    const backtickBlocks = (content.match(/```/g) || []).length;
    if (backtickBlocks % 2 === 0) {
      return { stable: content, pending: '' };
    }

    const lastOpening = content.lastIndexOf('```');
    if (lastOpening === -1) {
      return { stable: content, pending: '' };
    }

    const newlineBefore = content.lastIndexOf('\n', lastOpening);
    const stable = newlineBefore !== -1 ? content.slice(0, newlineBefore) : content.slice(0, lastOpening);
    const pending = content.slice(stable.length);
    return { stable, pending };
  }

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
          elements.push(<CodeBlock key={index} code={codeToken.text} language={codeToken.lang} />);
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
          console.warn(`Marked parsing failed for final buffer, falling back to raw text:`, e);
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
  const { stable, pending } = splitStableContent(message.content ?? '');
  const stableElements = useMemo(() => renderMarkdownTokens(stable), [stable]);

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
              {stableElements}
              {pending && <Text>{pending}</Text>}
            </Box>
          )}
          {message.tool_calls.map(tc => {
            const expanded = expandedTools.has(tc.id);
            const focused = focusedToolId === tc.id;

            // Look up from toolResults
            const resultMeta = toolResults.get(tc.id);

            // Look up the tool content from messages
            const toolMsg = allMessages.find(m => m.role === 'tool' && m.tool_call_id === tc.id);

            let result: { content: string; isError: boolean; durationMs: number } | undefined;
            if (toolMsg?.content) {
              result = {
                content: toolMsg.content,
                isError: resultMeta?.isError ?? false,
                durationMs: resultMeta?.durationMs ?? 0,
              };
            }

            const pending = currentTools.some(t => t.toolCall.id === tc.id);

            return (
              <Box key={tc.id} marginY={1}>
                <ToolCallMessage
                  toolCall={tc}
                  result={result}
                  pending={pending}
                  focused={focused}
                  expanded={expanded}
                />
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Don't render standalone tool messages - they're rendered inline with the assistant message
  if (message.role === 'tool') {
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
        {stableElements}
        {pending && <Text>{pending}</Text>}
      </Box>
    </Box>
  );
}