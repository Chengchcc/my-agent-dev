import { Box, Text } from 'ink';
import React from 'react';

export function Header() {
  return (
    <Box>
      <Text>
        <Text bold color="blue">my-agent</Text> - interactive AI agent terminal
      </Text>
    </Box>
  );
}