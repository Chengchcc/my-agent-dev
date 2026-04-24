import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { AgentContext } from '../../src/types';
import type { MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor, MemoryConfig } from '../../src/memory/types';
import { MemoryMiddleware } from '../../src/memory/middleware';
import { DEFAULT_MEMORY_CONFIG } from '../../src/memory/types';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'test-id',
    type: 'semantic',
    text: 'test',
    weight: 1,
    source: 'explicit',
    created: new Date().toISOString(),
    ...overrides,
  };
}

class MockMemoryStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  add = vi.fn().mockImplementation(e => Promise.resolve({ ...e, id: 'mock-id', created: new Date().toISOString() }));
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
}

class MockRetriever implements Partial<MemoryRetriever> {
  results: MemoryEntry[] = [];
  search = vi.fn().mockImplementation(() => Promise.resolve(this.results));
}

class MockExtractor implements Partial<MemoryExtractor> {
  extract = vi.fn().mockResolvedValue([]);
  consolidate = vi.fn().mockResolvedValue([]);
}

function buildContext(overrides: Partial<AgentContext>): AgentContext {
  return {
    messages: [],
    systemPrompt: 'You are a helpful assistant.',
    config: { tokenLimit: 100000, defaultSystemPrompt: undefined, model: 'test' },
    metadata: {},
    ...overrides,
  };
}

describe('MemoryMiddleware.beforeModel', () => {
  let middleware: MemoryMiddleware;
  let mockRetriever: MockRetriever;
  let mockExtractor: MockExtractor;
  let stores: {
    semantic: MockMemoryStore;
    episodic: MockMemoryStore;
    project: MockMemoryStore;
  };

  beforeEach(() => {
    stores = {
      semantic: new MockMemoryStore(),
      episodic: new MockMemoryStore(),
      project: new MockMemoryStore(),
    };
    mockRetriever = new MockRetriever();
    mockExtractor = new MockExtractor();
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      {},
    );
  });

  it('injects relevant memories into systemPrompt within <memory> tags', async () => {
    mockRetriever.results = [
      makeEntry({ type: 'semantic', text: 'prefers vitest' }),
    ];

    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'set up tests' }],
      systemPrompt: 'You are a helpful assistant.',
    });

    await middleware.beforeModel(context, async () => context);

    expect(context.systemPrompt).toContain('<memory>');
    expect(context.systemPrompt).toContain('prefers vitest');
    expect(context.systemPrompt).toContain('You are a helpful assistant.');
  });

  it('does not modify systemPrompt when no relevant memories', async () => {
    mockRetriever.results = [];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'original prompt',
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toBe('original prompt');
    expect(context.systemPrompt).not.toContain('<memory>');
  });

  it('sets <memory> section when systemPrompt is undefined', async () => {
    mockRetriever.results = [makeEntry({ type: 'semantic', text: 'fact' })];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: undefined,
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('<memory>');
    expect(context.systemPrompt).toContain('fact');
  });

  it('replaces old <memory> block instead of accumulating', async () => {
    mockRetriever.results = [makeEntry({ type: 'semantic', text: 'round 1' })];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'base\n\n<memory>\nold memory\n</memory>',
    });

    await middleware.beforeModel(context, async () => context);
    const memoryMatches = context.systemPrompt!.match(/<memory>/g);
    expect(memoryMatches).toHaveLength(1);
    expect(context.systemPrompt).not.toContain('old memory');
    expect(context.systemPrompt).toContain('round 1');
  });

  it('does not search or inject when there is no user message', async () => {
    const searchSpy = vi.spyOn(mockRetriever, 'search');
    const context: AgentContext = buildContext({
      messages: [{ role: 'assistant', content: 'thinking...' }],
      systemPrompt: 'base',
    });

    await middleware.beforeModel(context, async () => context);
    expect(searchSpy).not.toHaveBeenCalled();
  });
});

describe('MemoryMiddleware.afterAgentRun', () => {
  let middleware: MemoryMiddleware;
  let mockRetriever: MockRetriever;
  let mockExtractor: MockExtractor;
  let stores: {
    semantic: MockMemoryStore;
    episodic: MockMemoryStore;
    project: MockMemoryStore;
  };

  beforeEach(() => {
    stores = {
      semantic: new MockMemoryStore(),
      episodic: new MockMemoryStore(),
      project: new MockMemoryStore(),
    };
    mockRetriever = new MockRetriever();
    mockExtractor = new MockExtractor();
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      { autoExtractMinToolCalls: 3 },
    );
  });

  it('triggers async extraction when conditions are met (does not block return)', async () => {
    const extractSpy = vi.spyOn(mockExtractor, 'extract').mockResolvedValue([
      makeEntry({ type: 'semantic', text: 'learned fact' }),
    ]);

    const context = buildContext({
      messages: [
        { role: 'user', content: 'set up vitest' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'file content', tool_call_id: '1' },
        { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'write', arguments: '{}' } }] },
        { role: 'tool', content: 'written', tool_call_id: '2' },
        { role: 'assistant', content: null, tool_calls: [{ id: '3', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'done', tool_call_id: '3' },
        { role: 'assistant', content: 'All done!' },
      ],
    });

    const result = await middleware.afterAgentRun(context, async () => context);

    expect(result).toBeDefined();
    await middleware.awaitPendingExtractions();
    expect(extractSpy).toHaveBeenCalledOnce();
  });

  it('does not trigger extraction when toolCallCount < autoExtractMinToolCalls', async () => {
    const extractSpy = vi.spyOn(mockExtractor, 'extract');
    const context = buildContext({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi!' },
      ],
    });

    await middleware.afterAgentRun(context, async () => context);
    await middleware.awaitPendingExtractions();
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('does not trigger extraction when last assistant message has tool_calls (task not complete)', async () => {
    const extractSpy = vi.spyOn(mockExtractor, 'extract');
    const context = buildContext({
      messages: [
        { role: 'user', content: 'test' },
        { role: 'tool', content: 'r1', tool_call_id: '1' },
        { role: 'tool', content: 'r2', tool_call_id: '2' },
        { role: 'tool', content: 'r3', tool_call_id: '3' },
        { role: 'assistant', content: null, tool_calls: [{ id: '4', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      ],
    });

    await middleware.afterAgentRun(context, async () => context);
    await middleware.awaitPendingExtractions();
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it('distributes extracted entries to correct stores by type', async () => {
    vi.spyOn(mockExtractor, 'extract').mockResolvedValue([
      makeEntry({ type: 'semantic', text: 'pref' }),
      makeEntry({ type: 'episodic', text: 'did something' }),
      makeEntry({ type: 'project', text: 'uses bun' }),
    ]);

    const addSpies = {
      semantic: vi.spyOn(stores.semantic, 'add'),
      episodic: vi.spyOn(stores.episodic, 'add'),
      project: vi.spyOn(stores.project, 'add'),
    };

    const context = buildContext({
      messages: [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'content', tool_call_id: '1' },
        { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'write', arguments: '{}' } }] },
        { role: 'tool', content: 'done', tool_call_id: '2' },
        { role: 'assistant', content: null, tool_calls: [{ id: '3', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'check', tool_call_id: '3' },
        { role: 'assistant', content: 'Done' },
      ],
    });

    await middleware.afterAgentRun(context, async () => context);
    await middleware.awaitPendingExtractions();

    expect(addSpies.semantic).toHaveBeenCalledWith(expect.objectContaining({ type: 'semantic' }));
    expect(addSpies.episodic).toHaveBeenCalledWith(expect.objectContaining({ type: 'episodic' }));
    expect(addSpies.project).toHaveBeenCalledWith(expect.objectContaining({ type: 'project' }));
  });

  it('logs error but does not crash when extraction fails', async () => {
    vi.spyOn(mockExtractor, 'extract').mockRejectedValue(new Error('LLM down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const context = buildContext({
      messages: [
        { role: 'user', content: 'test' },
        { role: 'assistant', content: null, tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'content', tool_call_id: '1' },
        { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'write', arguments: '{}' } }] },
        { role: 'tool', content: 'done', tool_call_id: '2' },
        { role: 'assistant', content: null, tool_calls: [{ id: '3', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', content: 'check', tool_call_id: '3' },
        { role: 'assistant', content: 'Done' },
      ],
    });

    const result = await middleware.afterAgentRun(context, async () => context);
    await middleware.awaitPendingExtractions();

    expect(result).toBeDefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[memory]'),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

describe('formatMemories output formatting', () => {
  let middleware: MemoryMiddleware;
  let mockRetriever: MockRetriever;
  let mockExtractor: MockExtractor;
  let stores: {
    semantic: MockMemoryStore;
    episodic: MockMemoryStore;
    project: MockMemoryStore;
  };
  let config: MemoryConfig;

  beforeEach(() => {
    stores = {
      semantic: new MockMemoryStore(),
      episodic: new MockMemoryStore(),
      project: new MockMemoryStore(),
    };
    mockRetriever = new MockRetriever();
    mockExtractor = new MockExtractor();
    config = { maxInjectedEntries: 10 };
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      config,
    );
  });

  it('semantic memories go to "User Preferences" section', async () => {
    mockRetriever.results = [
      makeEntry({ type: 'semantic', text: 'prefers dark mode' }),
    ];
    const context = buildContext({ messages: [{ role: 'user', content: 'test' }] });
    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('## User Preferences (Relevant)');
    expect(context.systemPrompt).toContain('- prefers dark mode');
  });

  it('project memory shows "Current Project: {name}" section', async () => {
    mockRetriever.results = [
      makeEntry({ type: 'project', text: 'monorepo', projectPath: '/home/user/my-agent-dev' }),
    ];
    const context = buildContext({ messages: [{ role: 'user', content: 'test' }] });
    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('## Current Project: my-agent-dev');
    expect(context.systemPrompt).toContain('monorepo');
  });

  it('episodic memories go to "Recent Work" section with date prefix', async () => {
    mockRetriever.results = [
      makeEntry({ type: 'episodic', text: 'fixed rendering bug', created: '2024-06-15T10:00:00Z' }),
    ];
    const context = buildContext({ messages: [{ role: 'user', content: 'test' }] });
    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('## Recent Work');
    expect(context.systemPrompt).toContain('2024-06-15: fixed rendering bug');
  });

  it('respects maxInjectedEntries configuration for episodic', async () => {
    // Test the bug: originally hardcoded to 5, should respect config
    const maxInjectedEntries = 3;
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      { maxInjectedEntries },
    );

    mockRetriever.results = Array(10).fill(null).map((_, i) =>
      makeEntry({ type: 'episodic', text: `event ${i}` })
    );

    const context = buildContext({ messages: [{ role: 'user', content: 'test' }] });
    await middleware.beforeModel(context, async () => context);
    const matches = context.systemPrompt!.match(/event \d/g);
    expect(matches!.length).toBeLessThanOrEqual(maxInjectedEntries);
  });

  it('episodic respects maxInjectedEntries when total exceeds', async () => {
    const maxInjectedEntries = 7;
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      { maxInjectedEntries },
    );

    // Mix of types: 2 semantic, 1 project, 10 episodic = total 13
    mockRetriever.results = [
      makeEntry({ type: 'semantic', text: 'pref 1' }),
      makeEntry({ type: 'semantic', text: 'pref 2' }),
      makeEntry({ type: 'project', text: 'project', projectPath: '/test' }),
      ...Array(10).fill(null).map((_, i) => makeEntry({ type: 'episodic', text: `event ${i}` })),
    ];

    const context = buildContext({ messages: [{ role: 'user', content: 'test' }] });
    await middleware.beforeModel(context, async () => context);

    // Should not exceed maxInjectedEntries total
    const allEntries = (context.systemPrompt!.match(/- /g) || []).length;
    expect(allEntries).toBeLessThanOrEqual(maxInjectedEntries);
  });
});
