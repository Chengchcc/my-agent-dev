import { describe, it, expect } from 'bun:test';
import { DEFAULT_SYSTEM_PROMPT } from '../../src/config/default-prompts';
import { ReadTool } from '../../src/tools/read';
import { GrepTool } from '../../src/tools/grep';
import { GlobTool } from '../../src/tools/glob';
import { LsTool } from '../../src/tools/ls';
import { BashTool } from '../../src/tools/bash';
import { TextEditorTool } from '../../src/tools/text-editor';
import { planExecution } from '../../src/agent/dispatch';
import type { ToolImplementation, ToolCall } from '../../src/types';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { ToolRegistry } from '../../src/agent/tool-registry';

function makeCall(id: string, name: string): ToolCall {
  return { id, name, arguments: {} };
}

describe('Parallel tool call prompt integration', () => {
  // ===== System prompt assertions =====

  it('DEFAULT_SYSTEM_PROMPT contains <parallel_tool_calls> section', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('<parallel_tool_calls>');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('SINGLE assistant response');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('When to batch (DO)');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('When NOT to batch');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('self-sufficient');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Do not batch more than 8');
  });

  it('DEFAULT_SYSTEM_PROMPT names read-only tools as safe to batch', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('read_file, grep, glob, list_dir');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('always safe to batch with each other');
  });

  // ===== Tool description assertions =====

  it('read-only tools say SAFE TO CALL IN PARALLEL', () => {
    const read = new ReadTool();
    const grep = new GrepTool();
    const glob = new GlobTool();
    const ls = new LsTool();

    for (const tool of [read, grep, glob, ls]) {
      const def = tool.getDefinition();
      expect(def.description).toContain('SAFE TO CALL IN PARALLEL');
    }
  });

  it('write tools warn against batching', () => {
    const bash = new BashTool({});
    const editor = new TextEditorTool([]);

    expect(bash.getDefinition().description).toContain('Emit one bash call per response');
    expect(editor.getDefinition().description).toContain('DO NOT batch');
  });

  it('readonly tools have readonly=true', () => {
    const read = new ReadTool();
    const grep = new GrepTool();
    const glob = new GlobTool();
    const ls = new LsTool();

    expect(read.readonly).toBe(true);
    expect(grep.readonly).toBe(true);
    expect(glob.readonly).toBe(true);
    expect(ls.readonly).toBe(true);
  });

  it('write tools have conflict keys', () => {
    const bash = new BashTool({});
    const editor = new TextEditorTool([]);

    expect(bash.readonly).toBe(false);
    expect(editor.readonly).toBe(false);
    expect(bash.conflictKey?.({})).toBe('bash:global');
    expect(editor.conflictKey?.({ path: '/foo/bar.ts' })).toBe('file:/foo/bar.ts');
  });

  // ===== Wave planning assertions =====

  it('3 reads + 1 edit + 2 reads → 3 waves (canonical case)', () => {
    const registry = new ToolRegistry();
    const read = new ReadTool();
    const grep = new GrepTool();
    const editor = new TextEditorTool([]);
    registry.register(read);
    registry.register(grep);
    registry.register(editor);

    const calls: ToolCall[] = [
      makeCall('1', 'read'),
      makeCall('2', 'grep'),
      makeCall('3', 'read'),
      makeCall('4', 'text_editor'),
      makeCall('5', 'read'),
      makeCall('6', 'grep'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(3);
    // Wave 0: 3 readonly tools in parallel
    expect(plan.waves[0]).toHaveLength(3);
    // Wave 1: 1 write tool alone
    expect(plan.waves[1]).toHaveLength(1);
    expect(plan.waves[1]![0]!.name).toBe('text_editor');
    // Wave 2: 2 readonly tools in parallel
    expect(plan.waves[2]).toHaveLength(2);
  });

  it('max 8 parallel reads still goes in one wave', () => {
    const registry = new ToolRegistry();
    registry.register(new ReadTool());

    const calls: ToolCall[] = Array.from({ length: 8 }, (_, i) =>
      makeCall(String(i), 'read'),
    );

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]).toHaveLength(8);
  });

  it('all writes: each gets its own wave', () => {
    const registry = new ToolRegistry();
    registry.register(new BashTool({}));
    registry.register(new TextEditorTool([]));

    const calls: ToolCall[] = [
      makeCall('1', 'bash'),
      makeCall('2', 'text_editor'),
      makeCall('3', 'bash'),
    ];

    const plan = planExecution(calls, (name) => registry.get(name));
    expect(plan.waves).toHaveLength(3);
    for (const wave of plan.waves) {
      expect(wave).toHaveLength(1);
    }
  });
});
