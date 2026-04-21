import React from 'react';
import { Box } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { getBuiltinCommands } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage } from './ChatMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
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
      <AppContent skillCommands={skillCommands} sessionStore={sessionStore} />
    </AgentLoopProvider>
  );
}

function AppContent({ skillCommands, sessionStore }: { skillCommands: SlashCommand[]; sessionStore: SessionStore }) {
  const { messages, streaming: isStreaming, onSubmitWithSkill, abort, todos } = useAgentLoop();

  const allCommands = [...getBuiltinCommands(sessionStore), ...skillCommands];

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <ScrollView>
        {messages.map((message, index) => (
          <ChatMessage
            key={message.id ?? index}
            message={message}
            isStreaming={isStreaming && index === messages.length - 1}
          />
        ))}
      </ScrollView>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {isStreaming && <StreamingIndicator />}
      <InputBox commands={allCommands} onSubmit={onSubmitWithSkill} onAbort={abort} />
      <Footer />
    </Box>
  );
}
