import { Agent, ContextManager, ClaudeProvider, type AgentConfig } from '../src';

// Example usage - set env vars first
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = process.env.ANTHROPIC_BASE_URL;

if (!API_KEY) {
  console.error('Please set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

async function main() {
  // Create provider
  const provider = new ClaudeProvider({
    apiKey: API_KEY,
    model: 'claude-3-sonnet-20240229',
    maxTokens: 1024,
    temperature: 0.7,
    baseURL: BASE_URL,
  });

  // Create context manager
  const contextManager = new ContextManager({
    tokenLimit: 100000,
    defaultSystemPrompt: 'You are a helpful assistant.',
  });

  // Create agent config
  const agentConfig: AgentConfig = {
    tokenLimit: 100000,
  };

  // Create agent with optional logging middleware
  const agent = new Agent({
    provider,
    contextManager,
    config: agentConfig,
    middleware: [
      async (context, next) => {
        console.log(`[Before] ${context.messages.length} messages`);
        const result = await next();
        console.log(`[After] response: ${result.response?.content.slice(0, 50)}...`);
        return result;
      },
    ],
  });

  // Run conversation
  const result = await agent.run({
    role: 'user',
    content: 'Hello! What is a general purpose agent?',
  });

  console.log('\nFinal response:');
  console.log(result.response?.content);
}

main().catch(console.error);
