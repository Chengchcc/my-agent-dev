import React from 'react';
import { Box } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage } from './ChatMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';

export interface AppProps {
  agent: Agent;
}

export function App({ agent }: AppProps) {
  return (
    <AgentLoopProvider agent={agent}>
      <AppContent />
    </AgentLoopProvider>
  );
}

function AppContent() {
  const { messages, streaming: isStreaming, onSubmit, todos } = useAgentLoop();

  return (
    <Box flexDirection="column" height="100%">
      <Header />
      <ScrollView>
        {messages.map((message, index) => (
          <ChatMessage key={index} message={message} />
        ))}
      </ScrollView>
      {todos.length > 0 && <TodoPanel todos={todos} />}
      {isStreaming && <StreamingIndicator />}
      <InputBox onSubmit={onSubmit} />
      <Footer />
    </Box>
  );
}
