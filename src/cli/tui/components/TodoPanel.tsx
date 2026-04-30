import { Box, Text } from 'ink';
import React from 'react';
import type { UITodoItem } from '../types';
import { BlinkingText } from './';
import { debugLog } from '../../../utils/debug';

interface TodoPanelProps {
  todos: UITodoItem[];
}

export function TodoPanel({ todos }: TodoPanelProps) {
  debugLog('[render] TodoPanel', { count: todos.length });
  const getStatusStyle = (status: UITodoItem['status']) => {
    switch (status) {
      case 'pending':
        return { color: 'gray', bold: false, strikethrough: false, dimColor: false };
      case 'in_progress':
        return { color: 'yellow', bold: true, strikethrough: false, dimColor: false };
      case 'completed':
        return { color: 'green', bold: false, strikethrough: true, dimColor: true };
      case 'cancelled':
        return { color: 'gray', bold: false, strikethrough: true, dimColor: false };
      default:
        return { color: 'gray', bold: false, strikethrough: false, dimColor: false };
    }
  };

  const getStatusIndicator = (status: UITodoItem['status']): string => {
    switch (status) {
      case 'pending':
        return '○';
      case 'in_progress':
        return '◉';
      case 'completed':
        return '✓';
      case 'cancelled':
        return '✗';
      default:
        return '○';
    }
  };

  if (todos.length === 0) {
    return null;
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      marginY={1}
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Todo List
        </Text>
      </Box>
      {todos.map((todo, index) => {
        const style = getStatusStyle(todo.status);
        const indicator = getStatusIndicator(todo.status);

        return (
          <Box key={todo.id} marginBottom={0.5}>
            <Text>
              <Text color="gray" dimColor>{index + 1}.</Text>
              {' '}
              <Text {...style}>
                {todo.status === 'in_progress' ? (
                  <BlinkingText color="cyan">{indicator}</BlinkingText>
                ) : (
                  indicator
                )} {todo.content}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
