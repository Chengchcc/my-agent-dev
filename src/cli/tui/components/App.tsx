import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { debugLog } from '../../../utils/debug';
import { Box, Static, useInput } from 'ink';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { useAskUserQuestionManager, usePermissionManager } from '../hooks';
import { useTerminalWidth } from '../hooks/use-terminal-width';
import { useEventLoopStall } from '../hooks/use-event-loop-stall';
import { getBuiltinCommands } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage, PureChatMessage, ToolGroupMessage, groupToolCalls, type GroupedItem } from './ChatMessage';
import { ToolCallMessage } from './ToolCallMessage';
import { StreamingMessage } from './StreamingMessage';
import { ThinkingMessage } from './ThinkingMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
import { AskUserQuestionPrompt } from './AskUserQuestionPrompt';
import { PermissionPrompt } from './PermissionPrompt';
import { DebugOverlay } from './DebugOverlay';
import { BlinkProvider } from './BlinkContext';
import { ErrorBoundary } from './ErrorBoundary';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';

const COMPACT_TERMINAL_WIDTH = 80;

interface AppProps {
  agent: Agent;
  skillCommands: SlashCommand[];
  sessionStore: SessionStore;
}

export function App({ agent, skillCommands, sessionStore }: AppProps) {
  return (
    <AgentLoopProvider agent={agent} sessionStore={sessionStore}>
      <BlinkProvider>
        <AppContent skillCommands={skillCommands} sessionStore={sessionStore} />
      </BlinkProvider>
    </AgentLoopProvider>
  );
}

/** Number of most recent message groups kept in ScrollView for tool-call interactivity. */
const DYNAMIC_WINDOW = 1;

type StaticItem = GroupedItem | { type: 'banner' };

// eslint-disable-next-line max-lines-per-function -- comprehensive TUI layout
function AppContent({ skillCommands, sessionStore }: { skillCommands: SlashCommand[]; sessionStore: SessionStore }) {
  useEventLoopStall(process.env.DEBUG_STALL === '1');
  const { messages, streaming: isStreaming, streamingContent, thinkingContent, onSubmitWithSkill, abort, todos, moveFocus, toggleFocusedTool, ignoreError, focusedToolId, toolResults, ignoredErrors } = useAgentLoop();
  const scrollRef = useRef<ScrollViewRef>(null);
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();
  const { permissionRequest, respondToPermission } = usePermissionManager();
  const [thinkingCollapsed, setThinkingCollapsed] = useState(true);
  const [debugShow, setDebugShow] = useState(false);

  const focusedErrorTool = focusedToolId ? toolResults.get(focusedToolId) : null;
  const hasFocusedError = focusedErrorTool?.isError === true && !ignoredErrors.has(focusedToolId ?? '');

  useInput((input, key) => {
    // Ctrl+T — toggle thinking collapse
    if (input === 't' && key.ctrl) {
      setThinkingCollapsed(prev => !prev);
      return;
    }

    // Ctrl+D — toggle debug overlay
    if (input === 'd' && key.ctrl) {
      setDebugShow(prev => !prev);
      return;
    }

    // Esc during streaming — interrupt the agent
    if (key.escape && isStreaming) {
      abort();
      return;
    }

    // Ctrl+Up — previous tool
    if (key.upArrow && key.ctrl) {
      moveFocus(-1);
      return;
    }

    // Ctrl+Down — next tool
    if (key.downArrow && key.ctrl) {
      moveFocus(1);
      return;
    }

    // Ctrl+O or Space — toggle focused tool expand/collapse
    if ((input === 'o' && key.ctrl) || input === ' ') {
      toggleFocusedTool();
      return;
    }

    // Tool error action bar: i=ignore
    if (hasFocusedError && !isStreaming) {
      if (input === 'i') { ignoreError(focusedToolId!); return; }
    }
  }, { isActive: isStreaming || !!askUserQuestionRequest || !!permissionRequest || hasFocusedError });

  // Auto-scroll to bottom on discrete events only — NOT on every streamingContent
  // character delta (streaming content naturally stays at the viewport bottom).
  const prevStreamingRef = useRef(isStreaming);
  const prevMsgLenRef = useRef(messages.length);
  useEffect(() => {
    // Scroll when streaming starts or a new message/tool-result lands.
    // Streaming content deltas don't need scrolling since text appends at bottom.
    const streamingStarted = isStreaming && !prevStreamingRef.current;
    const newMessageArrived = messages.length !== prevMsgLenRef.current;
    if (streamingStarted || newMessageArrived) {
      queueMicrotask(() => scrollRef.current?.scrollToBottom());
    }
    prevStreamingRef.current = isStreaming;
    prevMsgLenRef.current = messages.length;
  }, [isStreaming, messages.length]);

  const terminalWidth = useTerminalWidth();
  const isCompact = terminalWidth < COMPACT_TERMINAL_WIDTH;

  const allCommands = [...getBuiltinCommands(sessionStore), ...skillCommands];

  // Ref-cached groupToolCalls: avoids creating new wrapper objects on every render
  // when messages reference hasn't changed (common during streaming-only updates).
  const groupedCache = useRef<{ input: Message[]; output: ReturnType<typeof groupToolCalls> }>({ input: [], output: [] });
  const groupedMessages = useMemo(() => {
    if (groupedCache.current.input === messages) return groupedCache.current.output;
    const result = groupToolCalls(messages);
    groupedCache.current = { input: messages, output: result };
    return result;
  }, [messages]);

  // Split messages: old completed messages go to <Static> (rendered once, never
  // re-measured), recent messages stay in ScrollView for tool-call interactivity.
  const dynamicItems = groupedMessages.slice(-DYNAMIC_WINDOW);

  // Stable static items — only grow (monotonic append), never create new references
  // for already-rendered items. This prevents <Static> from re-flushing all history.
  const staticRef = useRef<typeof groupedMessages>([]);
  const nextStatic = groupedMessages.slice(0, -DYNAMIC_WINDOW);
  if (nextStatic.length >= staticRef.current.length) {
    // Monotonic append: reuse old references for the common prefix
    const samePrefix = nextStatic.slice(0, staticRef.current.length).every((item, i) => item === staticRef.current[i]);
    if (samePrefix) {
      staticRef.current = nextStatic;
    } else {
      // Prefix mismatch (compaction changed message content) — full replace
      staticRef.current = nextStatic;
    }
  } else if (nextStatic.length !== staticRef.current.length) {
    staticRef.current = nextStatic;
  }
  const staticItems = staticRef.current;

  // Header rendered once as the first Static item — prevents it from being
  // "photocopied" into scrollback on every Static flush.
  const bannerItem = useMemo(() => ({ type: 'banner' as const }), []);
  const staticItemsWithBanner: StaticItem[] = useMemo(
    () => [bannerItem, ...staticItems],
    [bannerItem, staticItems],
  );

  // Dynamic items use context-connected ChatMessage for tool-call interactivity
  const renderItem = useCallback(
    (item: (typeof groupedMessages)[number], index: number) => {
      if (item.type === 'group') {
        return <ToolGroupMessage key={`group-${item.messages[0]?.id ?? index}`} group={item} />;
      }
      return (
        <ChatMessage
          key={`msg-${item.message.id ?? index}`}
          message={item.message}
        />
      );
    },
    [],
  );

  // Static items use PureChatMessage — no context hooks needed (render once, never update)
  const renderStaticItem = useCallback(
    (item: StaticItem, index: number) => {
      if (item.type === 'banner') {
        return <Header key="banner" sessionStore={sessionStore} />;
      }
      if (item.type === 'group') {
        return <ToolGroupMessage key={`group-${item.messages[0]?.id ?? index}`} group={item} />;
      }
      return (
        <PureChatMessage
          key={`msg-${item.message.id ?? index}`}
          message={item.message}
          ToolCallComponent={ToolCallMessage}
        />
      );
    },
    [sessionStore],
  );

  debugLog('[render] AppContent', {
    msgCount: groupedMessages.length,
    hasThinking: thinkingContent !== null,
    hasStreaming: streamingContent !== null,
    todoCount: todos.length,
  });

  return (
    <>
      <Static items={staticItemsWithBanner}>
        {(item, index) => renderStaticItem(item, index)}
      </Static>
      <Box flexDirection="column" height="100%">
        <ErrorBoundary name="ScrollView">
          <Box flexGrow={1} flexDirection="column" overflow="hidden">
            <ScrollView ref={scrollRef}>
              {dynamicItems.map((item, index) => renderItem(item, staticItems.length + index))}
              {thinkingContent !== null && (
                <ThinkingMessage content={thinkingContent} streaming={isStreaming} collapsed={thinkingCollapsed} />
              )}
              {!!isStreaming && (
                <StreamingMessage content={streamingContent ?? ''} />
              )}
            </ScrollView>
          </Box>
        </ErrorBoundary>
        {askUserQuestionRequest ? <AskUserQuestionPrompt
            questions={askUserQuestionRequest.params.questions}
            onSubmit={respondWithAnswers}
          /> : null}
        {permissionRequest ? <PermissionPrompt
            request={permissionRequest}
            onSubmit={respondToPermission}
          /> : null}
        <StreamingIndicator />
        <TodoPanel todos={todos} />
        {!askUserQuestionRequest && !permissionRequest && (
          <InputBox commands={allCommands} onSubmit={onSubmitWithSkill} onAbort={abort} />
        )}
        <DebugOverlay enabled={debugShow} />
        <ErrorBoundary name="Footer">
          <Footer compact={isCompact} />
        </ErrorBoundary>
      </Box>
    </>
  );
}
