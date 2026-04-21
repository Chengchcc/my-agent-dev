import { render } from 'ink';
import React from 'react';
import { Agent } from '../../agent';
import type { SlashCommand } from './command-registry';
import { App } from './components';
import { SessionStore } from '../../session/store';

export function runTUIClient(agent: Agent, skillCommands: SlashCommand[]): void {
  const sessionStore = new SessionStore();
  render(<App agent={agent} skillCommands={skillCommands} sessionStore={sessionStore} />);
}
