import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { AgentContext } from '../../src/types';
import type { MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor, MemoryConfig } from '../../src/memory/types';
import { MemoryMiddleware } from '../../src/memory/middleware';

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
  getAll = vi.fn().mockImplementation(() => Promise.resolve([...this.entries]));
}

class MockRetriever implements Partial<MemoryRetriever> {
  results: MemoryEntry[] = [];
  search = vi.fn().mockImplementation((_query: string, options?: { limit?: number; projectPath?: string; type?: string }) => {
    if (options?.type) {
      return Promise.resolve(this.results.filter(e => e.type === options.type));
    }
    return Promise.resolve(this.results);
  });
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

  it('injects user preferences into system prompt as <user_preferences>', async () => {
    stores.semantic.entries = [
      makeEntry({ type: 'semantic', text: 'prefers vitest' }),
    ];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'set up tests' }],
      systemPrompt: 'You are a helpful assistant.',
    });

    await middleware.beforeModel(context, async () => context);

    expect(context.systemPrompt).toContain('<user_preferences');
    expect(context.systemPrompt).toContain('prefers vitest');
    expect(context.systemPrompt).toContain('You are a helpful assistant.');
  });

  it('injects episodic recall into ephemeralReminders as <retrieved_memory>', async () => {
    mockRetriever.results = [
      makeEntry({ type: 'episodic', text: 'fixed rendering bug', created: '2024-06-15T10:00:00Z' }),
    ];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'set up tests' }],
      systemPrompt: 'You are a helpful assistant.',
    });

    await middleware.beforeModel(context, async () => context);

    expect(context.ephemeralReminders).toBeDefined();
    const reminder = context.ephemeralReminders![0]!;
    expect(reminder).toContain('<retrieved_memory>');
    expect(reminder).toContain('(2024-06-15) fixed rendering bug');
    // systemPrompt should NOT contain episodic content
    expect(context.systemPrompt).not.toContain('fixed rendering bug');
  });

  it('does not inject user_preferences when store is empty', async () => {
    stores.semantic.entries = [];
    mockRetriever.results = [];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'original prompt',
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('original prompt');
    expect(context.systemPrompt).not.toContain('<user_preferences>');
    expect(context.ephemeralReminders).toBeUndefined();
  });

  it('sets user_preferences section when systemPrompt is undefined', async () => {
    stores.semantic.entries = [makeEntry({ type: 'semantic', text: 'fact' })];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: undefined,
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toContain('<user_preferences');
    expect(context.systemPrompt).toContain('fact');
  });

  it('replaces old user_preferences section instead of accumulating', async () => {
    stores.semantic.entries = [makeEntry({ type: 'semantic', text: 'round 2' })];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'base\n\n<user_preferences version="abc">\n- old pref\n</user_preferences>',
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).not.toContain('old pref');
    expect(context.systemPrompt).toContain('round 2');
    // Only one user_preferences tag
    const matches = context.systemPrompt!.match(/<user_preferences/g);
    expect(matches).toHaveLength(1);
  });

  it('does not search or inject when there is no user message', async () => {
    const searchSpy = vi.spyOn(mockRetriever, 'search');
    const context: AgentContext = buildContext({
      messages: [{ role: 'assistant', content: 'thinking...' }],
      systemPrompt: 'base',
    });

    await middleware.beforeModel(context, async () => context);
    expect(searchSpy).not.toHaveBeenCalled();
    expect(context.ephemeralReminders).toBeUndefined();
  });

  it('limits user preferences to top 20', async () => {
    stores.semantic.entries = Array(25).fill(null).map((_, i) =>
      makeEntry({ type: 'semantic', text: `pref ${i}` })
    );
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
      systemPrompt: 'base',
    });

    await middleware.beforeModel(context, async () => context);
    // Should include first 20 but not the 25th
    expect(context.systemPrompt).toContain('pref 0');
    expect(context.systemPrompt).toContain('pref 19');
    expect(context.systemPrompt).not.toContain('pref 24');
  });

  it('includes version attribute on user_preferences for cache stability', async () => {
    stores.semantic.entries = [makeEntry({ type: 'semantic', text: 'pref' })];
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.systemPrompt).toMatch(/<user_preferences version="[a-f0-9]+">/);
  });

  it('respects maxInjectedEntries for episodic recall', async () => {
    mockRetriever.results = Array(10).fill(null).map((_, i) =>
      makeEntry({ type: 'episodic', text: `event ${i}` })
    );
    middleware = new MemoryMiddleware(
      stores as any,
      mockRetriever as any,
      mockExtractor as any,
      { maxInjectedEntries: 3 },
    );
    const context: AgentContext = buildContext({
      messages: [{ role: 'user', content: 'test' }],
    });

    await middleware.beforeModel(context, async () => context);
    expect(context.ephemeralReminders).toBeDefined();
    const reminder = context.ephemeralReminders![0]!;
    const eventMatches = reminder.match(/event \d/g) || [];
    expect(eventMatches.length).toBeLessThanOrEqual(3);
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
      { autoExtractMinToolCalls: 3, extractTriggerMode: 'auto' },
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
