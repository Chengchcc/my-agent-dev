import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { AgentContext, Message, Provider } from '../../src/types';
import type { MemoryConfig } from '../../src/memory/types';
import { JsonlMemoryStore } from '../../src/memory/store';
import { KeywordRetriever } from '../../src/memory/retriever';
import { LlmExtractor } from '../../src/memory/extractor';
import { MemoryMiddleware } from '../../src/memory/middleware';

class ScriptedProvider implements Provider {
  private responses: Message[];
  private index = 0;

  constructor(responses: Message[]) {
    this.responses = responses;
  }

  async invoke(context: AgentContext) {
    const response = this.responses[this.index++];
    return { content: response.content || '', tool_calls: response.tool_calls };
  }

  async *stream(context: AgentContext) {
    const response = this.responses[this.index++];
    if (response.content) {
      yield { content: response.content };
    }
    if (response.tool_calls) {
      yield { tool_calls: response.tool_calls };
    }
  }
}

describe('Memory E2E flow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mem-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it('Session 1: executes task → auto-extracts memory → persists to disk', async () => {
    const config: MemoryConfig = { globalBaseDir: tmpDir, autoExtractMinToolCalls: 3 };
    const semanticStore = new JsonlMemoryStore('semantic', config);
    const episodicStore = new JsonlMemoryStore('episodic', config);
    const projectStore = new JsonlMemoryStore('project', config, tmpDir);

    const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
    const extractor = new LlmExtractor(new ScriptedProvider([
      {
        role: 'assistant',
        content: `[
          {"type": "semantic", "text": "project uses vitest", "weight": 0.8, "tags": ["testing"]}
        ]`,
      },
    ]) as any);

    const middleware = new MemoryMiddleware(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever,
      extractor,
      config,
    );

    // Simulate what agent context looks like after a complete run
    const context: AgentContext = {
      messages: [
        { role: 'user', content: 'set up vitest' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{"path":"package.json"}' } }] },
        { role: 'tool', content: 'file content', tool_call_id: '1' },
        { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'write', arguments: '{"path":"vitest.config.ts"}' } }] },
        { role: 'tool', content: 'written', tool_call_id: '2' },
        { role: 'assistant', content: null, tool_calls: [{ id: '3', type: 'function', function: { name: 'read', arguments: '{"path":"package.json"}' } }] },
        { role: 'tool', content: 'done', tool_call_id: '3' },
        { role: 'assistant', content: 'All done!' },
      ],
      systemPrompt: 'You are a helpful assistant.',
      config: { tokenLimit: 100000, defaultSystemPrompt: undefined, model: 'test' },
      metadata: {},
    };

    // Run afterAgentRun manually
    await middleware.afterAgentRun(context, async () => context);
    await middleware.awaitPendingExtractions();

    // Verify memory persisted to disk
    const semanticFile = path.join(tmpDir, 'semantic.jsonl');
    const content = await fs.readFile(semanticFile, 'utf8');
    expect(content).toContain('vitest');
  });

  it('Session 2: new conversation → auto-retrieves and injects previous memory', async () => {
    const config: MemoryConfig = { globalBaseDir: tmpDir };
    // Pre-write a memory
    const semanticStore = new JsonlMemoryStore('semantic', config);
    await semanticStore.add({ type: 'semantic', text: 'project uses vitest', weight: 0.8, source: 'implicit' });

    const episodicStore = new JsonlMemoryStore('episodic', config);
    const projectStore = new JsonlMemoryStore('project', config, tmpDir);

    const retriever = new KeywordRetriever(semanticStore, episodicStore, projectStore);
    const extractor = new LlmExtractor(new ScriptedProvider([]) as any);
    const middleware = new MemoryMiddleware(
      { semantic: semanticStore, episodic: episodicStore, project: projectStore },
      retriever,
      extractor,
      config,
    );

    // Call beforeModel directly
    const context: AgentContext = {
      messages: [{ role: 'user', content: 'set up vitest config' }],
      systemPrompt: 'You are a helpful assistant.',
      config: { tokenLimit: 100000, defaultSystemPrompt: undefined, model: 'test' },
      metadata: {},
    };

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('vitest');
    expect(context.systemPrompt).toContain('<memory>');
  });
});
