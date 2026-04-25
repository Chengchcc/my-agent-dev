import { Box, Text } from 'ink';
import React from 'react';
import { useAgentLoop } from '../hooks';
import type { PromptSubmission, SlashCommand } from '../command-registry';
import { useCommandInput } from '../hooks/use-command-input';
import { CommandList } from './CommandList';
import { HighlightedInput } from './HighlightedInput';

export function InputBox({
  commands,
  onSubmit,
  onAbort,
}: {
  commands: SlashCommand[];
  onSubmit?: (submission: PromptSubmission) => void | Promise<void>;
  onAbort?: () => void;
}) {
  const { streaming } = useAgentLoop();
  const inputProps: any = { commands };
  if (onSubmit) inputProps.onSubmit = onSubmit;
  if (onAbort) inputProps.onAbort = onAbort;
  const { filteredCommands, highlightedCommandName, pickerOpen, placeholder, selectedIndex, text, cursorOffset } =
    useCommandInput(inputProps);

  if (streaming) {
    return null;
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      {pickerOpen ? <CommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}
      <Box
        flexDirection="row"
        columnGap={1}
        borderStyle="single"
      >
        <Text color="green">{'>'}</Text>
        <Box flexGrow={1}>
          <HighlightedInput
            cursorOffset={cursorOffset}
            highlightedCommandName={highlightedCommandName}
            placeholder={placeholder}
            value={text}
          />
        </Box>
      </Box>
    </Box>
  );
}
