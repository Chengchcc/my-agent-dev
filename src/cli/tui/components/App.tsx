import React from 'react';
import { Box, useInput } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { useAskUserQuestionManager } from '../hooks';
import { getBuiltinCommands } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage } from './ChatMessage';
import { StreamingMessage } from './StreamingMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
import { AskUserQuestionPrompt } from './AskUserQuestionPrompt';
import { BlinkProvider } from './BlinkContext';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { SlashCommand } from '../command-registry';
import type { SessionStore } from '../../../session/store';

export interface AppProps {
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
  const { messages, streaming: isStreaming, streamingContent, onSubmitWithSkill, abort, todos, moveFocus, toggleFocusedTool } = useAgentLoop();
  const { askUserQuestionRequest, respondWithAnswers } = useAskUserQuestionManager();

  useInput((input, key) => {
    // Up arrow - previous tool
    if (key.upArrow) {
      moveFocus(-1);
      return;
    }

    // Down arrow - next tool
    if (key.downArrow) {
      moveFocus(1);
      return;
    }

    // Ctrl+O or Space - toggle expand/collapse
    if (input === 'o' && key.ctrl || input === ' ') {
      toggleFocusedTool();
      return;
    }
  }, { isActive: isStreaming || !!askUserQuestionRequest });

  const allCommands = [...getBuiltinCommands(sessionStore), ...skillCommands];

  return (
    <Box flexDirection="column" height="100%">
      <Header sessionStore={sessionStore} />
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        <ScrollView>
          {messages.map((message, index) => (
            <ChatMessage
              key={message.id ?? index}
              message={message}
            />
          ))}
          {streamingContent !== null && (
            <StreamingMessage content={streamingContent} />
          )}
          {todos.length > 0 && <TodoPanel todos={todos} />}
        </ScrollView>
      </Box>
      {askUserQuestionRequest && (
        <AskUserQuestionPrompt
          questions={askUserQuestionRequest.params.questions}
          onSubmit={respondWithAnswers}
        />
      )}
      {isStreaming && <StreamingIndicator />}
      {!askUserQuestionRequest && (
        <InputBox commands={allCommands} onSubmit={onSubmitWithSkill} onAbort={abort} />
      )}
      <Footer />
    </Box>
  );
}
