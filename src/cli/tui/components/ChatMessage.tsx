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

// Tool responses: don't show full content by default, truncate to prevent taking too much screen space
const MAX_TOOL_LINES = 8;
const MAX_TOOL_CHARS = 500;

export function ChatMessage({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  // Handle different role types with appropriate styling
  const getRoleColor = (role: string): string => {
    switch (role) {
      case 'user':
        return 'cyan';      // Nord cyan for user input
      case 'assistant':
        return 'white';     // Light gray/white for assistant output (Nord #d8dee9)
      case 'system':
        return 'yellow';    // Muted yellow for system messages (Nord #ebcb8b)
      case 'tool':
        return 'magenta';   // Muted purple for tool output (Nord #b48ead)
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
  // This prevents layout jumping when streaming incomplete markdown
  function splitStableContent(content: string): { stable: string; pending: string } {
    if (!isStreaming) {
      return { stable: content, pending: '' };
    }

    // Count open structures that can cause unstable parsing
    const backtickBlocks = (content.match(/```/g) || []).length;
    if (backtickBlocks % 2 === 0) {
      // All code blocks closed, everything is stable
      return { stable: content, pending: '' };
    }

    // Find the last opening ``` and split there
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
          // Flush any buffered text before adding the code block
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
          // Use token.raw to include the full original markdown including formatting markers like ## for headings
          // This preserves context so marked can render it correctly
          const tokenAny = token as any;
          if (tokenAny.raw) {
            textBuffer += tokenAny.raw;
          } else if (tokenAny.text) {
            // Fallback to text if raw not available
            textBuffer += tokenAny.text;
          }
        }
      });

      // Flush any remaining text after processing all tokens
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
      // If overall lexing/parsing fails, fall back to full raw text
      console.warn('Marked lexing failed, falling back to full raw text:', e);
      elements.push(<Text>{content}</Text>);
    }

    return elements;
  }

  function truncateToolContent(content: string): { content: string; truncated: boolean } {
    const lines = content.split('\n');
    if (lines.length <= MAX_TOOL_LINES && content.length <= MAX_TOOL_CHARS) {
      return { content, truncated: false };
    }
    // Truncate to limits
    const previewLines = lines.slice(0, MAX_TOOL_LINES);
    let preview = previewLines.join('\n');
    let truncated = false;

    if (preview.length > MAX_TOOL_CHARS) {
      preview = preview.slice(0, MAX_TOOL_CHARS);
      truncated = true;
    } else if (lines.length > MAX_TOOL_LINES) {
      truncated = true;
    }

    if (truncated) {
      preview += '\n... (output truncated, full content saved to context)';
    }

    return { content: preview, truncated };
  }

  const roleColor = getRoleColor(message.role);
  const rolePrefix = getRolePrefix(message.role);

  // Handle tool content truncation
  let contentToRender = message.content;
  if (message.role === 'tool') {
    const { content } = truncateToolContent(message.content);
    contentToRender = content;
  }

  const { stable, pending } = splitStableContent(contentToRender);
  const stableElements = useMemo(() => renderMarkdownTokens(stable), [stable]);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={roleColor}>
          {rolePrefix} {message.role}:
          {message.role === 'tool' && message.content.length > MAX_TOOL_CHARS && (
            <Text color="gray" dimColor> [truncated]</Text>
          )}
        </Text>
      </Box>
      <Box paddingLeft={1} flexDirection="column">
        {stableElements}
        {pending && <Text>{pending}</Text>}
      </Box>
    </Box>
  );
}
