import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { ReadTool } from '../../src/tools/read';
import { GrepTool } from '../../src/tools/grep';
import { GlobTool } from '../../src/tools/glob';
import { LsTool } from '../../src/tools/ls';

describe('ZodTool schema generation', () => {
  test('ReadTool definition has correct types for all fields', () => {
    const tool = new ReadTool();
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.path.type).toBe('string');
    expect(props.start_line.type).toBe('number');  // ZodDefault handled correctly
    expect(props.max_lines.type).toBe('number');   // ZodDefault handled correctly
    expect(props.encoding.type).toBe('string');    // ZodDefault handled correctly
  });

  test('ReadTool default fields should NOT be in required array', () => {
    const tool = new ReadTool();
    const def = tool.getDefinition();
    const required = def.parameters.required as string[] | undefined;

    expect(required).toContain('path');
    if (required) {
      expect(required).not.toContain('start_line');  // has default → not required
      expect(required).not.toContain('max_lines');   // has default → not required
      expect(required).not.toContain('encoding');    // has default → not required
    } else {
      // If required is undefined, there are no required fields which is even better
      // But path should be required, so this shouldn't happen
      expect.fail('path should be in required array');
    }
  });

  test('GrepTool definition has correct types and defaults', () => {
    const tool = new GrepTool();
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;
    const required = def.parameters.required as string[] | undefined;

    expect(props.pattern.type).toBe('string');
    expect(props.path.type).toBe('string');         // has default
    expect(props.max_results.type).toBe('number');   // has default
    expect(required).toContain('pattern');
    if (required) {
      expect(required).not.toContain('path');
      expect(required).not.toContain('max_results');
    }
  });

  test('GlobTool definition has correct types and defaults', () => {
    const tool = new GlobTool();
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;
    const required = def.parameters.required as string[] | undefined;

    expect(props.pattern.type).toBe('string');
    expect(props.path.type).toBe('string');
    expect(props.max_results.type).toBe('number');
    expect(required).toContain('pattern');
    if (required) {
      expect(required).not.toContain('path');
      expect(required).not.toContain('max_results');
    }
  });

  test('LsTool definition has correct types and defaults', () => {
    const tool = new LsTool();
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;
    const required = def.parameters.required as string[] | undefined;

    expect(props.path.type).toBe('string');
    expect(props.depth.type).toBe('number');
    expect(props.include_hidden.type).toBe('boolean');
    expect(props.sort_by.type).toBe('string');
    // All fields have defaults, so if required exists, none should contain them
    if (required) {
      expect(required).not.toContain('path');
      expect(required).not.toContain('depth');
      expect(required).not.toContain('include_hidden');
      expect(required).not.toContain('sort_by');
    }
  });

  test('all file tools have valid JSON Schema - every property has a type', () => {
    const tools = [new ReadTool(), new GrepTool(), new GlobTool(), new LsTool()];
    for (const tool of tools) {
      const def = tool.getDefinition();
      const props = def.parameters.properties as Record<string, any>;
      for (const [key, value] of Object.entries(props)) {
        expect(value.type, `${def.name}.${key} missing 'type' field`).toBeDefined();
      }
    }
  });

  test('ZodDefault includes default value in JSON Schema', () => {
    // Verify that the default value is included in the output
    const tool = new ReadTool();
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.encoding.default).toBe('utf8');
    expect(props.max_lines.default).toBe(500);
  });
});
