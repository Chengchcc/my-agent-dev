// src/agent/tool-registry.ts
import type { Tool, ToolImplementation } from '../types';

/**
 * ToolRegistry - manages registration and lookup of tool implementations
 * Central registry that maps tool names to their implementations
 */
export class ToolRegistry {
  private tools: Map<string, ToolImplementation> = new Map();

  /**
   * Register a tool implementation with the registry
   */
  register(tool: ToolImplementation): void {
    const definition = tool.getDefinition();
    this.tools.set(definition.name, tool);
  }

  /**
   * Unregister a tool from the registry
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool implementation by name
   */
  get(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Get all tool definitions for registration with provider
   */
  getAllDefinitions(): Tool[] {
    return Array.from(this.tools.values()).map(tool => tool.getDefinition());
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Get number of registered tools
   */
  size(): number {
    return this.tools.size;
  }
}
