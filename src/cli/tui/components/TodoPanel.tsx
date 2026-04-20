import { Box, Text } from 'ink';
import React from 'react';
import type { UITodoItem } from '../types';

interface TodoPanelProps {
  todos: UITodoItem[];
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const getStatusStyle = (status: UITodoItem['status']) => {
    switch (status) {
      case 'pending':
        return { color: 'gray', bold: false, strikethrough: false, dimColor: false };
      case 'in_progress':
        return { color: 'yellow', bold: true, strikethrough: false, dimColor: false };
      case 'completed':
        return { color: 'green', bold: false, strikethrough: false, dimColor: true };
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
    return (
      <Box flexDirection="column">
        <Text color="gray" dimColor>
          No todos in list
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
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
              <Text color="gray">{index + 1}.</Text>
              {' '}
              <Text {...style}>
                {indicator} {todo.content}
              </Text>
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
