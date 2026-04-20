import { render } from 'ink';
import React from 'react';
import { Agent } from '../../agent';
import { App } from './components';

export function runTUIClient(agent: Agent): void {
  render(<App agent={agent} />);
}

export default runTUIClient;
