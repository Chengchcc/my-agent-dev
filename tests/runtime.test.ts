import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { RuntimeConfig, AgentRuntime } from '../src/runtime';
import { createAgentRuntime } from '../src/runtime';

describe('Runtime types', () => {
  it('should export RuntimeConfig and AgentRuntime types', () => {
    // Just verify the types compile (no runtime assertion needed)
    const config: RuntimeConfig = { model: 'test' };
    expect(config.model).toBe('test');
  });
});

describe('createAgentRuntime', () => {
  const originalClaudeKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalClaudeKey;
    if (originalOpenaiKey) process.env.OPENAI_API_KEY = originalOpenaiKey;
  });

  it('should create Claude provider when ANTHROPIC_API_KEY is set', async () => {
    const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
    expect(runtime.provider).toBeDefined();
    expect(runtime.agent).toBeDefined();
  });

  it('should register core tools', async () => {
    const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
    const toolNames = Array.from(runtime.toolRegistry.tools.keys());
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('text_editor');
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('grep');
    expect(toolNames).toContain('glob');
    expect(toolNames).toContain('ls');
    expect(toolNames).toContain('ask_user_question');
  });
});
