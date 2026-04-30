import { Box, Text, useInput } from 'ink';
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
  const { streaming, pendingInputs, clearPendingInputs } = useAgentLoop();
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

  // Ctrl+K to clear the entire pending queue
  useInput((_input, key) => {
    if (key.ctrl && _input === 'k' && pendingInputs.length > 0) {
      clearPendingInputs();
    }
  }, { isActive: pendingInputs.length > 0 });

  return (
    <Box flexDirection="column" rowGap={1}>
      {pickerOpen ? <CommandList commands={filteredCommands} selectedIndex={selectedIndex} /> : null}
      {atFilePickerOpen ? <FilePicker files={atFiles} selectedIndex={atSelectedIndex} /> : null}

      {/* Pending queue: show all queued inputs */}
      {pendingInputs.length > 0 ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
        >
          <Box>
            <Text color="yellow" bold>⏸ Queued ({pendingInputs.length}) </Text>
            <Text dimColor>
              {streaming
                ? '· will send after current turn · Ctrl+K to clear'
                : '· sending...'}
            </Text>
          </Box>
          {pendingInputs.map((text, idx) => {
            const preview = text.length > 120
              ? text.slice(0, 117).replace(/\n/g, '↵') + '...'
              : text.replace(/\n/g, '↵');
            return (
              <Box key={idx} flexDirection="row" columnGap={1}>
                <Text dimColor>{idx + 1}.</Text>
                <Text>{preview}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      <Box
        flexDirection="row"
        columnGap={1}
        borderStyle="single"
      >
        <Text color={streaming ? 'yellow' : 'green'}>{streaming ? '⧗' : '>'}</Text>
        <Box flexGrow={1}>
          <HighlightedInput
            cursorOffset={displayCursorOffset}
            highlightedCommandName={highlightedCommandName}
            placeholder={
              streaming && !displayText
                ? 'type to queue next message · enter to queue · esc to interrupt'
                : placeholder
            }
            value={displayText}
          />
        </Box>
      </Box>
    </Box>
  );
}
