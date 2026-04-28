import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { BlinkingText } from './BlinkingText';
import { ReadFileView } from './ReadFileView';
import type { ToolCall } from '../../../types';
import { formatToolCallTitle, smartSummarize, formatToolResult } from '../utils/tool-format';
import { useAgentLoopSelector } from '../hooks';

export interface ToolCallMessageProps {
  toolCall: ToolCall;
  result?: { content: string; isError: boolean; durationMs: number };
  pending?: boolean;
  focused?: boolean;
  expanded?: boolean;
  ignored?: boolean;
}

/**
 * Pure ToolCallMessage — renders tool call status from props.
 * Use directly in tests. In the app, use ConnectedToolCallMessage which reads from context.
 */
 
// eslint-disable-next-line complexity
export function ToolCallMessage({ toolCall, result, pending = false, focused = false, expanded = false, ignored = false }: ToolCallMessageProps) {
  // All hooks must be called unconditionally before any early return.
  // Otherwise when a read tool's result arrives (pending -> resolved),
  // the early return path changes hook count and React throws
  // "Rendered fewer hooks than expected".
  const title = useMemo(() => formatToolCallTitle(toolCall), [toolCall.name, toolCall.arguments]);

  const smartSummary = useMemo(
    () => result ? smartSummarize(toolCall.name, toolCall.arguments, result.content) : null,
    [toolCall.name, toolCall.arguments, result?.content],
  );

  const readParsed = useMemo(() => {
    if (pending || !result || result.isError || toolCall.name !== 'read') return null;
    try {
      const parsed = JSON.parse(result.content);
      if (parsed && parsed.path && parsed.content) return parsed;
    } catch { /* fall through */ }
    return null;
  }, [pending, result?.content, result?.isError, toolCall.name]);

  const formattedResult = useMemo(() => {
    if (!result) return { display: '', isCollapsible: false };
    if (result.isError) {
      const lines = result.content.split('\n');
      const display = lines.slice(0, 10).join('\n') +
        (lines.length > 10 ? `\n... (${lines.length} lines total)` : '');
      return { display, isCollapsible: lines.length > 10 };
    }
    return formatToolResult(result.content, result.isError, expanded);
  }, [result?.content, result?.isError, expanded]);

  // === hooks end — early returns below are safe ===

  const borderStyle = focused ? 'single' : undefined;
  const borderColor = focused ? 'blue' : undefined;
  const prefixColor = pending ? 'yellow' : result?.isError ? 'red' : 'gray';
  const contentColor = result?.isError ? 'red' : 'gray';

  if (readParsed) {
    return (
      <Box flexDirection="column" borderStyle={borderStyle} borderColor={borderColor} paddingX={focused ? 1 : 0} marginY={0}>
        <Box flexDirection="row" alignItems="center">
          <Text color={prefixColor}>
            {pending ? <BlinkingText>●</BlinkingText> : '●'}
          </Text>
          <Text color="cyan"> {title}</Text>
          {result ? <Text color="gray"> {result.durationMs}ms</Text> : null}
        </Box>
        {smartSummary ? <Box paddingLeft={2}>
            <Text color={contentColor}>{smartSummary}</Text>
          </Box> : null}
        {expanded ? (
          <ReadFileView
            filePath={readParsed.path}
            content={readParsed.content}
            startLine={readParsed.range.start}
            totalFileLines={readParsed.total_lines}
            {...(readParsed.diff ? { diff: { hunks: readParsed.diff.hunks } } : {})}
          />
        ) : (
          <Box paddingLeft={2}>
            <Text color="gray">Read 1 file (ctrl+o to expand)</Text>
          </Box>
        )}
      </Box>
    );
  }

  const content = smartSummary ?? formattedResult.display;

  return (
    <Box flexDirection="column" borderStyle={borderStyle} borderColor={borderColor} paddingX={focused ? 1 : 0} marginY={0}>
      <Box flexDirection="row" alignItems="center">
        <Text color={prefixColor}>
          {pending ? <BlinkingText>●</BlinkingText> : '●'}
        </Text>
        <Text color="cyan"> {title}</Text>
        {result ? <Text color="gray"> {result.durationMs}ms</Text> : null}
      </Box>
      {result && content ? <Box paddingLeft={2}>
          <Text color={contentColor}>{content}</Text>
        </Box> : null}
      {result?.isError && focused && !ignored ? <Box paddingLeft={2}>
          <Text color="yellow">[i] ignore</Text>
        </Box> : null}
    </Box>
  );
}

/**
 * ConnectedToolCallMessage — reads tool state from AgentLoopContext via individual scalar selectors.
 * Only the specific tool that changed re-renders (Object.is comparison on each selector).
 */
export function ConnectedToolCallMessage({ toolCall }: { toolCall: ToolCall }) {
  const pending = useAgentLoopSelector(s =>
    s.currentTools.some(t => t.toolCall.id === toolCall.id),
  );
  const focused = useAgentLoopSelector(s => s.focusedToolId === toolCall.id);
  const expanded = useAgentLoopSelector(s => s.expandedTools.has(toolCall.id));
  const ignored = useAgentLoopSelector(s => s.ignoredErrors.has(toolCall.id));
  const resultMeta = useAgentLoopSelector(s => s.toolResults.get(toolCall.id));
  const toolMsg = useAgentLoopSelector(s =>
    s.messages.find(m => m.role === 'tool' && m.tool_call_id === toolCall.id),
  );

  const result = useMemo(() => {
    if (!toolMsg?.content) return undefined;
    return {
      content: toolMsg.content,
      isError: resultMeta?.isError ?? false,
      durationMs: resultMeta?.durationMs ?? 0,
    };
  }, [toolMsg?.content, resultMeta?.isError, resultMeta?.durationMs]);

  return (
    <ToolCallMessage
      toolCall={toolCall}
      {...(result ? { result } : {})}
      pending={pending}
      focused={focused}
      expanded={expanded}
      ignored={ignored}
    />
  );
}
