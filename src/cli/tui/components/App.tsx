import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, useInput } from 'ink';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { useAskUserQuestionManager, usePermissionManager } from '../hooks';
import { useTerminalWidth } from '../hooks/use-terminal-width';
import { useEventLoopStall } from '../hooks/use-event-loop-stall';
import { getBuiltinCommands } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage, ToolGroupMessage, groupToolCalls } from './ChatMessage';
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
import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';

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

    // Ctrl+O or Space — toggle expand/collapse
    if ((input === 'o' && key.ctrl) || input === ' ') {
      toggleFocusedTool();
      return;
    }

    // Tool error action bar: i=ignore
    if (hasFocusedError && !isStreaming) {
      if (input === 'i') { ignoreError(focusedToolId!); return; }
    }
  }, { isActive: isStreaming || !!askUserQuestionRequest || !!permissionRequest || hasFocusedError });

  // Auto-scroll to bottom during streaming to prevent layout jitter
  useEffect(() => {
    if (isStreaming) {
      // queueMicrotask lets ScrollView finish its useLayoutEffect measurements first
      queueMicrotask(() => scrollRef.current?.scrollToBottom());
    }
  }, [isStreaming, messages.length, streamingContent]);

  const terminalWidth = useTerminalWidth();
  const isCompact = terminalWidth < 80;

  const allCommands = [...getBuiltinCommands(sessionStore), ...skillCommands];
  const groupedMessages = useMemo(() => groupToolCalls(messages), [messages]);

  return (
    <Box flexDirection="column" height="100%">
      <Header sessionStore={sessionStore} compact={isCompact} />
      <ErrorBoundary name="ScrollView">
        <Box flexGrow={1} flexDirection="column" overflow="hidden">
          <ScrollView ref={scrollRef}>
            {groupedMessages.map((item, index) => {
              if (item.type === 'group') {
                return <ToolGroupMessage key={item.messages[0]?.id ?? `group-${index}`} group={item} />;
              }
              return (
                <ChatMessage
                  key={item.message.id ?? `msg-${index}`}
                  message={item.message}
                />
              );
            })}
            {thinkingContent !== null && (
              <ThinkingMessage content={thinkingContent} streaming={isStreaming} collapsed={thinkingCollapsed} />
            )}
            {streamingContent !== null && (
              <StreamingMessage content={streamingContent} />
            )}
            {todos.length > 0 && <TodoPanel todos={todos} />}
          </ScrollView>
        </Box>
      </ErrorBoundary>
      {askUserQuestionRequest && (
        <AskUserQuestionPrompt
          questions={askUserQuestionRequest.params.questions}
          onSubmit={respondWithAnswers}
        />
      )}
      {permissionRequest && (
        <PermissionPrompt
          request={permissionRequest}
          onSubmit={respondToPermission}
        />
      )}
      {isStreaming && <StreamingIndicator />}
      {!askUserQuestionRequest && !permissionRequest && (
        <InputBox commands={allCommands} onSubmit={onSubmitWithSkill} onAbort={abort} />
      )}
      <DebugOverlay enabled={debugShow} />
      <ErrorBoundary name="Footer">
        <Footer compact={isCompact} />
      </ErrorBoundary>
    </Box>
  );
}
