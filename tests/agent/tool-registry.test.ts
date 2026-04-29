import { describe, it, expect } from 'bun:test';
import { ToolRegistry } from '../../src/agent/tool-registry';
import type { ToolImplementation, Tool, ToolContext } from '../../src/types';

class MockTool implements ToolImplementation {
  constructor(private toolName: string) {}
  getDefinition(): Tool {
    return { name: this.toolName, description: '', parameters: {} };
  }
  async execute(_params: Record<string, unknown>, _ctx: ToolContext): Promise<unknown> {
    return '';
  }
}

describe('ToolRegistry', () => {
  it('should allow registering tools', () => {
    const reg = new ToolRegistry();
    reg.register(new MockTool('test'));
    expect(reg.get('test')).toBeDefined();
  });

  it('should overwrite on duplicate registration', () => {
    const reg = new ToolRegistry();
    const tool1 = new MockTool('test');
    const tool2 = new MockTool('test');
    reg.register(tool1);
    reg.register(tool2);
    expect(reg.get('test')).toBe(tool2); // second one wins
  });

  it('should cache getAllDefinitions', () => {
    const reg = new ToolRegistry();
    reg.register(new MockTool('a'));
    const defs1 = reg.getAllDefinitions();
    const defs2 = reg.getAllDefinitions();
    expect(defs1).toEqual(defs2); // same content (defensive copy)
  });

  it('should invalidate cache on register', () => {
    const reg = new ToolRegistry();
    reg.register(new MockTool('a'));
    const defs1 = reg.getAllDefinitions();
    reg.register(new MockTool('b'));
    const defs2 = reg.getAllDefinitions();
    expect(defs1).not.toBe(defs2); // different reference = invalidated
    expect(defs2.length).toBe(2);
  });

  it('should invalidate cache on unregister', () => {
    const reg = new ToolRegistry();
    reg.register(new MockTool('a'));
    const defs1 = reg.getAllDefinitions();
    reg.unregister('a');
    const defs2 = reg.getAllDefinitions();
    expect(defs2.length).toBe(0);
  });

  it('should invalidate cache on clear', () => {
    const reg = new ToolRegistry();
    reg.register(new MockTool('a'));
    const defs1 = reg.getAllDefinitions();
    reg.clear();
    const defs2 = reg.getAllDefinitions();
    expect(defs2.length).toBe(0);
  });
});
