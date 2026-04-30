import { Box, Text } from 'ink';
import React, { useMemo } from 'react';
import { useAgentLoop } from '../hooks';
import { useBracketedPaste } from '../hooks/use-bracketed-paste';
import type { PromptSubmission, SlashCommand } from '../command-registry';
import { useCommandInput } from '../hooks/use-command-input';
import { CommandList } from './CommandList';
import { FilePicker } from './FilePicker';
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
  useBracketedPaste();
  const { streaming, pendingInput } = useAgentLoop();
  const inputProps = useMemo(
    () => {
      const props: { commands: SlashCommand[]; streaming: boolean; onSubmit?: (submission: PromptSubmission) => void | Promise<void>; onAbort?: () => void } = { commands, streaming };
      if (onSubmit) props.onSubmit = onSubmit;
      if (onAbort) props.onAbort = onAbort;
      return props;
    },
    [commands, streaming, onSubmit, onAbort],
  );
  const { filteredCommands, highlightedCommandName, pickerOpen, placeholder, selectedIndex, displayText, displayCursorOffset, atFiles, atSelectedIndex, atFilePickerOpen } =
    useCommandInput(inputProps);

  return (
    <Box flexDirection="column" rowGap={1}>
      {pickerOpen ? <CommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}
      {atFilePickerOpen ? <FilePicker files={atFiles} selectedIndex={atSelectedIndex} /> : null}
      {pendingInput ? (
        <Box flexDirection="row" columnGap={1} borderStyle="single">
          <Text dimColor>⏸</Text>
          <Text dimColor>{pendingInput}</Text>
        </Box>
      ) : null}
      <Box
        flexDirection="row"
        columnGap={1}
        borderStyle="single"
      >
        <Text color="green">{'>'}</Text>
        <Box flexGrow={1}>
          <HighlightedInput
            cursorOffset={displayCursorOffset}
            highlightedCommandName={highlightedCommandName}
            placeholder={placeholder}
            value={displayText}
          />
        </Box>
      </Box>
    </Box>
  );
}
