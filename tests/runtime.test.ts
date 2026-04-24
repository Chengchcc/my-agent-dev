import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { RuntimeConfig } from '../src/runtime';
import { createAgentRuntime } from '../src/runtime';
import type { AskUserQuestionParameters, AskUserQuestionResult } from '../src/tools/ask-user-question';

describe('RuntimeConfig', () => {
  test('works with empty config', () => {
    const config: RuntimeConfig = {};
    expect(config).toEqual({});
  });

  test('works with partial config', () => {
    const config: RuntimeConfig = {
      model: 'claude-3-opus',
      maxTokens: 4096,
      enableMemory: true,
    };
    expect(config.model).toBe('claude-3-opus');
    expect(config.maxTokens).toBe(4096);
    expect(config.enableMemory).toBe(true);
    expect(config.enableSkills).toBeUndefined();
  });

  test('supports askUserQuestionHandler with proper types', () => {
    const handler: (params: AskUserQuestionParameters) => Promise<AskUserQuestionResult> = async (params) => {
      return {
        answers: params.questions.map((_, i) => ({
          question_index: i,
          selected_labels: ['Test'],
        })),
      };
    };

    const config: RuntimeConfig = {
      askUserQuestionHandler: handler,
    };

    expect(config.askUserQuestionHandler).toBeDefined();
  });
});

describe('createAgentRuntime', () => {
  const originalClaudeKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalClaudeKey) {
      process.env.ANTHROPIC_API_KEY = originalClaudeKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalOpenaiKey) {
      process.env.OPENAI_API_KEY = originalOpenaiKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('should create Claude provider when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
    expect(runtime.provider).toBeDefined();
    expect(runtime.agent).toBeDefined();
  });

  test('should create OpenAI provider when OPENAI_API_KEY is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = 'test-openai-key';
    const runtime = await createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false });
    expect(runtime.provider).toBeDefined();
  });

  test('should throw error when no API key is found', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    expect(createAgentRuntime({ enableMemory: false, enableSkills: false, enableTodo: false, enableSession: false })).rejects.toThrow('No API key found');
  });

  test('should register core tools', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
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