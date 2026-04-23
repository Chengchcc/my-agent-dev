import { z } from 'zod';
import type { Tool, ToolImplementation } from '../types';

export abstract class ZodTool<T extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> implements ToolImplementation {
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

      // Check if field is required - check if it's not optional
      let current: z.ZodTypeAny = zodSchema;
      let isOptional = false;
      while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
        if (current instanceof z.ZodOptional) {
          isOptional = true;
        }
        current = current._def.innerType;
      }
      if (!isOptional) {
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

    // Handle optional and nullable types
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
      const innerSchema = this.zodToJsonSchema(schema._def.innerType);
      // Copy all properties from inner schema
      Object.assign(result, innerSchema);
      if (schema.description) {
        result.description = schema.description;
      }
      // JSON Schema doesn't require explicit marking for optional since it's in the required array
      return result;
    }

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

    if (schema instanceof z.ZodLiteral) {
      result.type = typeof schema.value;
      result.enum = [schema.value];
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodObject) {
      result.type = 'object';
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(schema.shape)) {
        const zodSchema = value as z.ZodTypeAny;
        properties[key] = this.zodToJsonSchema(zodSchema);

        // Check if field is required
        let current: z.ZodTypeAny = zodSchema;
        let isOptional = false;
        while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
          if (current instanceof z.ZodOptional) {
            isOptional = true;
          }
          current = current._def.innerType;
        }
        if (!isOptional) {
          required.push(key);
        }
      }

      result.properties = properties;
      if (required.length > 0) {
        result.required = required;
      }
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodUnion) {
      // For unions, we just add description if present
      if (schema.description) {
        result.description = schema.description;
      }
      return result;
    }

    if (schema instanceof z.ZodRecord) {
      result.type = 'object';
      result.additionalProperties = this.zodToJsonSchema(schema._def.valueType);
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

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const result = this.schema.safeParse(params);

    if (!result.success) {
      const errors = result.error.issues
        .map(issue => `- ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');
      return `Parameter validation failed:\n${errors}`;
    }

    return this.handle(result.data);
  }

  protected abstract handle(params: z.infer<T>): Promise<unknown> | unknown;
}

export default ZodTool;
