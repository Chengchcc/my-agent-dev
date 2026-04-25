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

  it('should accept prompt via --prompt flag', async () => {
    // This should fail with no API key, not with "no prompt" error
    const result = await $`bun run bin/my-agent.ts -p "hello" 2>&1`.nothrow().text();
    expect(result).not.toContain('No prompt provided');
  });

  it('should read prompt from stdin', async () => {
    const result = await $`echo "test prompt" | bun run bin/my-agent.ts 2>&1`.nothrow().text();
    expect(result).not.toContain('No prompt provided');
  });
});
