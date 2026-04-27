import { Box, Text } from "ink";
import React from 'react';

const MAX_VISIBLE_FILES = 8;

interface FilePickerProps {
  files: string[];
  selectedIndex: number;
}

export function FilePicker({ files, selectedIndex }: FilePickerProps) {
  if (files.length === 0) return null;

  const windowStart = Math.max(0, selectedIndex - MAX_VISIBLE_FILES + 1);
  const visible = files.slice(windowStart, windowStart + MAX_VISIBLE_FILES);

  return (
    <Box flexDirection="column" paddingX={2}>
      {visible.map((file, idx) => {
        const actualIndex = windowStart + idx;
        const isSelected = actualIndex === selectedIndex;
        return isSelected ? (
          <Box key={file}>
            <Text color="cyan">{'>'} {file}</Text>
          </Box>
        ) : (
          <Box key={file}>
            <Text>  {file}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
