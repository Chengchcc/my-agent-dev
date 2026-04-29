import { Box, Text, useInput } from 'ink';
import React, { useCallback, useEffect, useRef } from 'react';
import type { PermissionRequest, PermissionResponse } from '../../../tools';

interface PermissionPromptProps {
  request: PermissionRequest;
  onSubmit: (response: PermissionResponse) => void;
}

export function PermissionPrompt({ request, onSubmit }: PermissionPromptProps) {
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const submittedRef = useRef(false);

  const handleSubmit = useCallback((response: PermissionResponse) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    submitRef.current(response);
  }, []);

  useInput((input, _key) => {
    const lower = input.toLowerCase();
    if (lower === 'y') { handleSubmit('allow'); return; }
    if (lower === 'a') { handleSubmit('always'); return; }
    if (lower === 'n') { handleSubmit('deny'); return; }
  }, { isActive: true });

  useEffect(() => {
    return () => {
      if (!submittedRef.current) handleSubmit('deny');
    };
  }, [handleSubmit]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
      <Box>
        <Text bold color="yellow">Permission Required</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Allow <Text color="cyan">{request.toolName}</Text>?
        </Text>
      </Box>
      <Box>
        <Text dimColor>{request.reason}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="green">[y]</Text> allow once{'  '}
          <Text color="green">[a]</Text> always{'  '}
          <Text color="red">[N]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}
