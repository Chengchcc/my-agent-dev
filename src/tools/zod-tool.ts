import { z } from 'zod';
import type { Tool, ToolImplementation } from '../types';

export abstract class ZodTool<T extends z.ZodObject<any>> implements ToolImplementation {
  protected abstract schema: T;
  protected abstract name: string;
  protected abstract description: string;

  getDefinition(): Tool {
    // Convert Zod schema to JSON Schema
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    const shape = this.schema.shape;
    for (const [key, value] of Object.entries(shape)) {
      const zodSchema = value as z.ZodTypeAny;
      properties[key] = this.zodToJsonSchema(zodSchema);

      // Check if field is required
      if (!zodSchema.isOptional()) {
        required.push(key);
      }
    }

    const parameters: Record<string, unknown> = {
      type: 'object',
      properties,
    };

    if (required.length > 0) {
      parameters.required = required;
    }

    return {
      name: this.name,
      description: this.description,
      parameters,
    };
  }

  private zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    if (schema instanceof z.ZodString) {
      result.type = 'string';
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodNumber) {
      result.type = 'number';
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodBoolean) {
      result.type = 'boolean';
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodArray) {
      result.type = 'array';
      result.items = this.zodToJsonSchema(schema.element);
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodEnum) {
      result.type = 'string';
      result.enum = schema.options;
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodUnion) {
      // For unions, we just mark as any with description
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema.description) {
      result.description = schema.description;
    }

    return result;
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const result = this.schema.safeParse(params);

    if (!result.success) {
      const errors = result.error.issues
        .map(issue => `- ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      return `Parameter validation failed:\n${errors}`;
    }

    return this.handle(result.data);
  }

  protected abstract handle(params: z.infer<T>): Promise<string> | string;
}

export default ZodTool;
