import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { ZodTool } from '../../src/tools/zod-tool';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { ReadTool } from '../../src/tools/read';
import { GrepTool } from '../../src/tools/grep';
import { GlobTool } from '../../src/tools/glob';
import { LsTool } from '../../src/tools/ls';

// Helper: create a concrete ZodTool subclass for testing
function makeTool<T extends z.ZodObject<z.ZodRawShape>>(name: string, schema: T) {
  return new (class extends ZodTool<T> {
    protected schema = schema;
    protected name = name;
    protected description = 'Test tool';
    protected async handle(_params: z.infer<T>, _ctx: ToolContext): Promise<string> {
      return 'ok';
    }
  })();
}

const dummyCtx: ToolContext = {
  abortSignal: new AbortController().signal,
  message: { role: 'user', content: 'test' },
  toolCallId: 'test-1',
};

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

describe('ZodTool: ZodUnion schema → oneOf', () => {
  test('produces oneOf with correct option schemas', () => {
    const schema = z.object({
      result: z.union([z.string(), z.number()]),
    });
    const tool = makeTool('test_union', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.result.oneOf).toBeDefined();
    expect(props.result.oneOf).toHaveLength(2);
    expect(props.result.oneOf[0]).toEqual({ type: 'string' });
    expect(props.result.oneOf[1]).toEqual({ type: 'number' });
  });

  test('ZodUnion preserves description', () => {
    const schema = z.object({
      result: z.union([z.string(), z.number()]).describe('A string or number'),
    });
    const tool = makeTool('test_union_desc', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.result.oneOf).toBeDefined();
    expect(props.result.description).toBe('A string or number');
  });
});

describe('ZodTool: ZodDiscriminatedUnion → oneOf + discriminator', () => {
  test('produces oneOf with discriminator property', () => {
    const schema = z.object({
      shape: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('circle'), radius: z.number() }),
        z.object({ kind: z.literal('square'), side: z.number() }),
      ]),
    });
    const tool = makeTool('test_disc_union', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.shape.oneOf).toBeDefined();
    expect(props.shape.oneOf).toHaveLength(2);
    expect(props.shape.discriminator).toEqual({ propertyName: 'kind' });
  });

  test('ZodDiscriminatedUnion preserves description', () => {
    const schema = z.object({
      shape: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('circle'), radius: z.number() }),
        z.object({ kind: z.literal('square'), side: z.number() }),
      ]).describe('A geometric shape'),
    });
    const tool = makeTool('test_disc_union_desc', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.shape.oneOf).toBeDefined();
    expect(props.shape.description).toBe('A geometric shape');
  });
});

describe('ZodTool: ZodDate → { type: string, format: date-time }', () => {
  test('converts ZodDate to string with date-time format', () => {
    const schema = z.object({
      created: z.date(),
    });
    const tool = makeTool('test_date', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.created.type).toBe('string');
    expect(props.created.format).toBe('date-time');
  });

  test('ZodDate preserves description', () => {
    const schema = z.object({
      created: z.date().describe('Creation timestamp'),
    });
    const tool = makeTool('test_date_desc', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.created.description).toBe('Creation timestamp');
  });
});

describe('ZodTool: ZodEffects (.refine()) unwraps to inner type', () => {
  test('unwraps .refine() to inner ZodString', () => {
    const schema = z.object({
      email: z.string().refine(val => val.includes('@'), 'Must be a valid email'),
    });
    const tool = makeTool('test_effects', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.email.type).toBe('string');
  });

  test('ZodEffects preserves description from outer schema', () => {
    const schema = z.object({
      email: z.string()
        .refine(val => val.includes('@'), 'Must be a valid email')
        .describe('Email address'),
    });
    const tool = makeTool('test_effects_desc', schema);
    const def = tool.getDefinition();
    const props = def.parameters.properties as Record<string, any>;

    expect(props.email.description).toBe('Email address');
    expect(props.email.type).toBe('string');
  });
});

describe('ZodTool: parse failure should throw Error', () => {
  test('throws Error when params fail schema validation', async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const tool = makeTool('test_throw', schema);

    await expect(
      tool.execute({ name: 123, age: 'not-a-number' }, dummyCtx),
    ).rejects.toThrow('Parameter validation failed');
  });

  test('throws Error with descriptive message listing issues', async () => {
    const schema = z.object({
      name: z.string(),
    });
    const tool = makeTool('test_throw_msg', schema);

    await expect(
      tool.execute({}, dummyCtx),
    ).rejects.toThrow('Parameter validation failed');
  });

  test('does not throw for valid params', async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const tool = makeTool('test_no_throw', schema);

    const result = await tool.execute({ name: 'Alice', age: 30 }, dummyCtx);
    expect(result).toBe('ok');
  });
});
