import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { Message, Provider, AgentContext } from '../../src/types';
import type { MemoryEntry } from '../../src/memory/types';
import { LlmExtractor } from '../../src/memory/extractor';

class MockProvider implements Partial<Provider> {
  invokeResponse: string = '[]';
  invoke = vi.fn().mockImplementation((context: AgentContext) => {
    return Promise.resolve({ content: this.invokeResponse });
  });
}

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

describe('LlmExtractor.extract', () => {
  let extractor: LlmExtractor;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    extractor = new LlmExtractor(mockProvider as any);
  });

  it('extracts semantic and project memory entries from conversation', async () => {
    mockProvider.invokeResponse = `[
      {"type": "semantic", "text": "User prefers vitest over jest", "tags": ["testing"], "weight": 0.9},
      {"type": "project", "text": "TypeScript monorepo using Bun", "weight": 0.8}
    ]`;

    const messages: Message[] = [
      { role: 'user', content: 'Can you set up vitest? I prefer it over jest.' },
      { role: 'assistant', content: 'Done! I configured vitest in your Bun monorepo.' },
    ];

    const entries = await extractor.extract(messages, '/my/project');
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('semantic');
    expect(entries[0].source).toBe('implicit'); // auto-extracted = implicit
    expect(entries[1].projectPath).toBe('/my/project');
  });

  it('empty array from LLM → empty result', async () => {
    mockProvider.invokeResponse = '[]';
    const entries = await extractor.extract([{ role: 'user', content: 'hello' }]);
    expect(entries).toHaveLength(0);
  });

  it('non-JSON response from LLM → empty result, no throw', async () => {
    mockProvider.invokeResponse = 'I cannot extract any meaningful memories from this.';
    const entries = await extractor.extract([{ role: 'user', content: 'hi' }]);
    expect(entries).toHaveLength(0);
  });

  it('extracts JSON even when wrapped in extra text', async () => {
    mockProvider.invokeResponse = `Here are the extracted memories:
    [{"type": "semantic", "text": "prefers tabs", "weight": 0.7}]
    That's all I found.`;

    const entries = await extractor.extract([{ role: 'user', content: 'I use tabs' }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('prefers tabs');
  });

  it('filters out entries with empty text', async () => {
    mockProvider.invokeResponse = `[
      {"type": "semantic", "text": "", "weight": 0.5},
      {"type": "semantic", "text": "  ", "weight": 0.5},
      {"type": "semantic", "text": "valid", "weight": 0.8}
    ]`;
    const entries = await extractor.extract([{ role: 'user', content: 'test' }]);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('valid');
  });

  it('filters out entries missing type field', async () => {
    mockProvider.invokeResponse = `[
      {"text": "no type field", "weight": 0.5},
      {"type": "semantic", "text": "has type", "weight": 0.8}
    ]`;
    const entries = await extractor.extract([{ role: 'user', content: 'test' }]);
    expect(entries).toHaveLength(1);
  });
});

describe('LlmExtractor.consolidate', () => {
  let extractor: LlmExtractor;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    extractor = new LlmExtractor(mockProvider as any);
  });

  it('merges duplicate entries', async () => {
    mockProvider.invokeResponse = `[
      {"type": "semantic", "text": "User prefers vitest", "weight": 0.9, "id": "orig-1"}
    ]`;

    const input = [
      makeEntry({ id: 'orig-1', text: 'User prefers vitest over jest', weight: 0.8 }),
      makeEntry({ id: 'orig-2', text: 'User likes vitest, not jest', weight: 0.7 }),
    ];

    const result = await extractor.consolidate(input);
    expect(result.length).toBeLessThan(input.length);
  });

  it('preserves original id and created when LLM returns them', async () => {
    const origId = 'keep-this-id';
    const origCreated = '2024-01-15T00:00:00Z';
    mockProvider.invokeResponse = `[
      {"type": "semantic", "text": "consolidated", "weight": 0.9,
       "id": "${origId}", "created": "${origCreated}"}
    ]`;

    const result = await extractor.consolidate([makeEntry({})]);
    expect(result[0].id).toBe(origId);
    expect(result[0].created).toBe(origCreated);
  });

  it('returns empty array when LLM consolidation fails', async () => {
    mockProvider.invokeResponse = 'ERROR: could not process';
    const result = await extractor.consolidate([makeEntry({})]);
    expect(result).toEqual([]);
  });
});

describe('Prompt construction', () => {
  let extractor: LlmExtractor;
  let mockProvider: MockProvider;

  beforeEach(() => {
    mockProvider = new MockProvider();
    extractor = new LlmExtractor(mockProvider as any);
  });

  it('extraction prompt includes project path', async () => {
    const promptSpy = vi.spyOn(extractor as any, 'buildExtractionPrompt');
    mockProvider.invokeResponse = '[]';
    await extractor.extract([{ role: 'user', content: 'test' }], '/my/project');
    expect(promptSpy).toHaveBeenCalled();
    const prompt = promptSpy.mock.results[0].value as string;
    expect(prompt).toContain('/my/project');
  });

  it('extraction prompt includes security guidance about credentials', async () => {
    const promptSpy = vi.spyOn(extractor as any, 'buildExtractionPrompt');
    mockProvider.invokeResponse = '[]';
    await extractor.extract([{ role: 'user', content: 'test' }]);
    const prompt = promptSpy.mock.results[0].value as string;
    expect(prompt).toMatch(/credential|password|token|key/i);
  });

  it('consolidation prompt includes text and created of all entries', async () => {
    const promptSpy = vi.spyOn(extractor as any, 'buildConsolidationPrompt');
    mockProvider.invokeResponse = '[]';
    const entries = [
      makeEntry({ text: 'fact A', created: '2024-01-01T00:00:00Z' }),
      makeEntry({ text: 'fact B', created: '2024-06-01T00:00:00Z' }),
    ];
    await extractor.consolidate(entries);
    const prompt = promptSpy.mock.results[0].value as string;
    expect(prompt).toContain('fact A');
    expect(prompt).toContain('fact B');
    expect(prompt).toContain('2024-01-01');
  });

  it('uses extractionModel from constructor when provided', async () => {
    // This tests the bug fix: extractionModel should be configurable
    const customExtractor = new LlmExtractor(mockProvider as any, 'claude-3-5-sonnet-20240620');
    const invokeSpy = vi.spyOn(mockProvider, 'invoke');
    mockProvider.invokeResponse = '[]';
    await customExtractor.extract([{ role: 'user', content: 'test' }]);
    const calledContext = invokeSpy.mock.calls[0][0] as AgentContext;
    expect(calledContext.config.model).toBe('claude-3-5-sonnet-20240620');
  });
});
