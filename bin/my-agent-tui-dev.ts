#!/usr/bin/env bun
import 'dotenv/config';
import { Agent } from '../src/agent';
import { ContextManager } from '../src/agent/context';
import { ClaudeProvider } from '../src/providers/claude';
import { OpenAIProvider } from '../src/providers/openai';
import { SkillLoader } from '../src/skills/loader';
import { toSkillCommand, loadAvailableCommands } from '../src/cli/tui/command-registry';
import { runTUIClient } from '../src/cli/index';
import type { AgentConfig } from '../src/types';
import type { SkillFrontmatter } from '../src/skills/loader';

// Choose provider based on available API key
const defaultModel = process.env.MODEL || 'claude-3-5-sonnet-20241022';
const defaultMaxTokens = 4096;

let provider;
if (process.env.ANTHROPIC_API_KEY) {
  provider = new ClaudeProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    model: process.env.MODEL || 'claude-3-5-sonnet-20241022',
    maxTokens: defaultMaxTokens,
    temperature: 0.7,
  });
} else if (process.env.OPENAI_API_KEY) {
  provider = new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.MODEL || 'gpt-4o',
  });
} else {
  console.error('Error: No API key found. Set either ANTHROPIC_API_KEY or OPENAI_API_KEY in your .env file');
  process.exit(1);
}

const contextManager = new ContextManager({
  tokenLimit: 100000, // ~100k tokens should be enough for most conversations
});
const config: AgentConfig = {
  maxTokens: defaultMaxTokens,
  temperature: 0.7,
  model: defaultModel,
};

const agent = new Agent({
  provider,
  contextManager,
  config,
});

// Load skills and convert to slash commands
(async () => {
  const skillLoader = new SkillLoader();
  const skills = await skillLoader.loadAllSkills();
  const skillCommands = skills.map(toSkillCommand);

  runTUIClient(agent, skillCommands);
})();
