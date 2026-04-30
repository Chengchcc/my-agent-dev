import type { Message } from '../../../types';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';
import { ToolCallMessage, ConnectedToolCallMessage } from './ToolCallMessage';
import { renderMarkdownTokens } from './utils/render-markdown';
import { debugLog } from '../../../utils/debug';

const MIN_TOOL_GROUP_SIZE = 3;

export interface ToolGroup {
  type: 'group';
  toolName: string;
  count: number;
  messages: Message[];
}

export type GroupedItem = { type: 'single'; message: Message } | ToolGroup;

export function groupToolCalls(messages: Message[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length === 1) {
      const toolName = msg.tool_calls[0]!.name;
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j]!;
        if (next.role === 'assistant' && next.tool_calls && next.tool_calls.length === 1 && next.tool_calls[0]!.name === toolName) {
          j++;
        } else {
          break;
        }
      }
      if (j - i >= MIN_TOOL_GROUP_SIZE) {
        result.push({ type: 'group', toolName, count: j - i, messages: messages.slice(i, j) });
        i = j;
        continue;
      }
    }
    result.push({ type: 'single', message: msg });
    i++;
  }
  return result;
}

interface PureChatMessageProps {
  message: Message;
  /** Override the tool call renderer — defaults to pure ToolCallMessage (no context required, for testing) */
  ToolCallComponent?: React.ComponentType<{ toolCall: import('../../../types').ToolCall }> // eslint-disable-line @typescript-eslint/consistent-type-imports
}

/**
 * Pure (context-free) ChatMessage component for testing.
 * Defaults to pure ToolCallMessage. ChatMessage overrides with ConnectedToolCallMessage.
 */
export function PureChatMessage({ message, ToolCallComponent = ToolCallMessage }: PureChatMessageProps) {
  debugLog('[render] PureChatMessage', { id: message.id, role: message.role, hasContent: !!message.content, toolCount: message.tool_calls?.length ?? 0 });

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
          {message.content ? <Box flexDirection="column">
              {elements}
            </Box> : null}
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

interface ToolGroupMessageProps {
  group: ToolGroup;
}

export function ToolGroupMessage({ group }: ToolGroupMessageProps) {
  debugLog('[render] ToolGroupMessage', { toolName: group.toolName, count: group.count });
  return (
    <Box marginBottom={1} marginLeft={1}>
      <Text dimColor>
        {'\u25B6'} {group.toolName} {group.count} files
      </Text>
    </Box>
  );
}
