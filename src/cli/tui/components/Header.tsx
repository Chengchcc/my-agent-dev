import { Box, Text } from 'ink';
import React from 'react';

// ASCII hamster logo for the TUI header
const HAMSTER_LOGO = `\
▄█▄█▄
█●█●█
▀███▀
 █ █`;

export function Header() {
  return (
    <Box flexDirection="row" alignItems="center" gap={1}>
      <Text>{HAMSTER_LOGO}</Text>
      <Text>
        <Text bold color="blue">my-agent</Text> - interactive AI agent terminal
      </Text>
    </Box>
  );
}