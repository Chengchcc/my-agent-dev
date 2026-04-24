import { expandTilde, mergeConfigs } from '../../src/config/loader';
import type { Settings } from '../../src/config/types';
import { defaultSettings } from '../../src/config/defaults';

describe('expandTilde', () => {
  test('expands ~ to home directory', () => {
    const input = '~/test/file.txt';
    const result = expandTilde(input);
    expect(result).toContain(process.env.HOME!);
    expect(result).toEndWith('/test/file.txt');
  });

  test('leaves absolute path without ~ unchanged', () => {
    const input = '/absolute/path/file.txt';
    expect(expandTilde(input)).toBe(input);
  });

  test('leaves relative path unchanged', () => {
    const input = './relative/path';
    expect(expandTilde(input)).toBe(input);
  });
});

describe('mergeConfigs', () => {
  test('returns defaults when user config is empty', () => {
    const result = mergeConfigs(defaultSettings, {});
    expect(result).toEqual(defaultSettings);
  });

  test('overrides top-level fields', () => {
    const user: Partial<Settings> = {
      debug: { enabled: true },
    };
    const result = mergeConfigs(defaultSettings, user);
    expect(result.debug.enabled).toBe(true);
    expect(result.llm.model).toBe(defaultSettings.llm.model);
  });

  test('overrides nested llm fields', () => {
    const user: Partial<Settings> = {
      llm: {
        model: 'custom-model',
        maxTokens: 8192,
      },
    };
    const result = mergeConfigs(defaultSettings, user);
    expect(result.llm.model).toBe('custom-model');
    expect(result.llm.maxTokens).toBe(8192);
    expect(result.llm.provider).toBe(defaultSettings.llm.provider);
  });

  test('overrides nested tui fields', () => {
    const user: Partial<Settings> = {
      tui: {
        history: {
          maxLines: 500,
        },
      },
    };
    const result = mergeConfigs(defaultSettings, user);
    expect(result.tui.history.maxLines).toBe(500);
    expect(result.tui.history.filePath).toBe(defaultSettings.tui.history.filePath);
    expect(result.tui.sessions.dir).toBe(defaultSettings.tui.sessions.dir);
  });
});
