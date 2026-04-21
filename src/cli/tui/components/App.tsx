import React from 'react';
import { Box } from 'ink';
import { ScrollView } from 'ink-scroll-view';
import { AgentLoopProvider, useAgentLoop } from '../hooks/use-agent-loop';
import { BUILTIN_COMMANDS } from '../command-registry';
import { Header } from './Header';
import { Footer } from './Footer';
import { ChatMessage } from './ChatMessage';
import { TodoPanel } from './TodoPanel';
import { InputBox } from './InputBox';
import { StreamingIndicator } from './StreamingIndicator';
import type { Agent } from '../../../agent';
import type { Message } from '../../../types';
import type { SlashCommand } from '../command-registry';

export interface AppProps {
  agent: Agent;
  skillCommands: SlashCommand[];
}

export function App({ agent, skillCommands }: AppProps) {
  return (
    <AgentLoopProvider agent={agent}>
      <AppContent skillCommands={skillCommands} />
    </AgentLoopProvider>
  );
}

function AppContent({ skillCommands }: { skillCommands: SlashCommand[] }) {
  const { messages, streaming: isStreaming, onSubmitWithSkill, abort, todos } = useAgentLoop();

  const allCommands = [...BUILTIN_COMMANDS, ...skillCommands];

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
