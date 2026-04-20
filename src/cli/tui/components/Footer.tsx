import { Box, Text } from 'ink';
import React from 'react';

export function Footer() {
  return (
    <Box marginTop={1}>
      <Text dimColor>Type /exit to quit, /clear to clear conversation</Text>
    </Box>
  );
}