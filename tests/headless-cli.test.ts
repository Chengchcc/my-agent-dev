import { describe, it, expect } from 'bun:test';
import { $ } from 'bun';

describe('Headless CLI', () => {
  it('should show help with --help flag', async () => {
    const result = await $`bun run bin/my-agent.ts --help`.text();
    expect(result).toContain('Usage:');
    expect(result).toContain('--prompt');
    expect(result).toContain('--output-format');
  });

  it('should show version with --version flag', async () => {
    const result = await $`bun run bin/my-agent.ts --version`.text();
    expect(result.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
