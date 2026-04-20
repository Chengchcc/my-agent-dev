import { Box, Text, useInput } from 'ink';
import React, { useState } from 'react';
import { useAgentLoop } from '../hooks';

export function InputBox({
  onSubmit,
}: {
  onSubmit: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const { streaming } = useAgentLoop();

  useInput((input, key) => {
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
        setValue('');
      }
      return;
    }
    setValue(prev => prev + input);
  });

  if (streaming) {
    return null;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">{'> '}</Text>
        <Text>{value}</Text>
      </Box>
    </Box>
  );
}