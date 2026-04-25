// src/agent/tool-registry.ts
import type { Tool, ToolImplementation } from '../types';
import { debugWarn } from '../utils/debug';

/**
 * ToolRegistry - manages registration and lookup of tool implementations
 * Central registry that maps tool names to their implementations
 */
export class ToolRegistry {
  private _tools: Map<string, ToolImplementation> = new Map();
  private _definitionsCache: Tool[] | null = null;

  /**
   * Register a tool implementation with the registry
   */
  register(tool: ToolImplementation): void {
    const definition = tool.getDefinition();

    // Detect and warn on duplicate registration
    if (this._tools.has(definition.name)) {
      debugWarn(`[ToolRegistry] Duplicate tool registration: '${definition.name}' — overwriting`);
    }

    this._tools.set(definition.name, tool);
    this._definitionsCache = null; // invalidate cache
  }

  /**
   * Unregister a tool from the registry
   */
  unregister(name: string): boolean {
    this._definitionsCache = null;
    return this._tools.delete(name);
  }

  /**
   * Get a tool implementation by name
   */
  get(name: string): ToolImplementation | undefined {
    return this._tools.get(name);
  }

  /**
   * Check if a tool is registered
   */
  has(name: string): boolean {
    return this._tools.has(name);
  }

  /**
   * Get all tool definitions for registration with provider.
   * Result is cached until the registry is mutated.
   */
  getAllDefinitions(): Tool[] {
    if (!this._definitionsCache) {
      this._definitionsCache = Array.from(this._tools.values()).map(tool => tool.getDefinition());
    }
    return this._definitionsCache;
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this._definitionsCache = null;
    this._tools.clear();
  }

  /**
   * Get number of registered tools
   */
  size(): number {
    return this._tools.size;
  }

  /**
   * Get the underlying tools map (for inspection)
   */
  get tools(): ReadonlyMap<string, ToolImplementation> {
    return this._tools;
  }
}
