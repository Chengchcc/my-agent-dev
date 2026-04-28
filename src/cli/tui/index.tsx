import { render } from 'ink';
import React from 'react';
import type { Agent } from '../../agent';
import type { SlashCommand } from './command-registry';
import { App } from './components';
import type { SessionStore } from '../../session/store';

export function runTUIClient(agent: Agent, skillCommands: SlashCommand[], sessionStore: SessionStore): void {
  render(<App agent={agent} skillCommands={skillCommands} sessionStore={sessionStore} />);
}
