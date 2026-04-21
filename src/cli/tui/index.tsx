import { render } from 'ink';
import React from 'react';
import { Agent } from '../../agent';
import type { SlashCommand } from './command-registry';
import { App } from './components';

export function runTUIClient(agent: Agent, skillCommands: SlashCommand[]): void {
  render(<App agent={agent} skillCommands={skillCommands} />);
}
