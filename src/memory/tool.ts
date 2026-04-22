import type { Tool, ToolImplementation } from '../types';
import type { MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor } from './types';

export class MemoryTool implements ToolImplementation {
  constructor(
    private stores: {
      semantic: MemoryStore;
      episodic: MemoryStore;
      project: MemoryStore;
    },
    private retriever: MemoryRetriever,
    private extractor: MemoryExtractor,
  ) {}

  getDefinition(): Tool {
    return {
      name: 'memory',
      description: `Read, write, or search persistent memory across conversations. Use to remember user preferences, project facts, and important decisions.

Commands:
- search: Find relevant memories for a query
- add: Store a new reusable memory
- list: List recent memories (optionally filter by type)
- forget: Remove a specific memory by ID
- consolidate: Trigger deduplication/consolidation of semantic memory

Only store genuinely reusable information that will be useful in future conversations. Do not store transient conversation details.`,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ['search', 'add', 'list', 'forget', 'consolidate'],
            description: 'Operation to perform',
          },
          query: {
            type: 'string',
            description: 'Search query (for search command)',
          },
          text: {
            type: 'string',
            description: 'Memory content to store (for add command)',
          },
          id: {
            type: 'string',
            description: 'Memory ID (for forget command)',
          },
          type: {
            type: 'string',
            enum: ['semantic', 'episodic', 'project'],
            description: 'Filter by memory type (for list), or type of new memory (for add)',
          },
          limit: {
            type: 'number',
            description: 'Maximum results to return (default: 10)',
          },
        },
        required: ['command'],
      },
    };
  }

  async execute(params: Record<string, unknown>): Promise<unknown> {
    const command = params.command as string;
    const projectPath = process.cwd();

    switch (command) {
      case 'search': {
        const query = params.query as string;
        const limit = (params.limit as number) || 10;
        if (!query) {
          throw new Error('query parameter is required for search command');
        }
        const results = await this.retriever.search(query, { limit, projectPath });
        return { results };
      }

      case 'add': {
        const text = params.text as string;
        const type = (params.type as MemoryEntry['type']) || 'semantic';
        if (!text) {
          throw new Error('text parameter is required for add command');
        }
        const store = this.getStoreForType(type);
        const added = await store.add({
          type,
          text,
          weight: 1.0,
          source: 'explicit',
          projectPath: type === 'project' ? projectPath : undefined,
        });
        return { added };
      }

      case 'list': {
        const type = params.type as MemoryEntry['type'] | undefined;
        const limit = (params.limit as number) || 10;
        if (type) {
          const store = this.getStoreForType(type);
          const entries = await store.getRecent(limit, type);
          return { entries };
        }
        // Get from all stores, merge and sort by recency
        const semantic = await this.stores.semantic.getRecent(Math.ceil(limit / 3));
        const episodic = await this.stores.episodic.getRecent(Math.ceil(limit / 3));
        const project = await this.stores.project.getRecent(Math.ceil(limit / 3));
        const all = [...semantic, ...episodic, ...project];
        const entries = all
          .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
          .slice(0, limit);
        return { entries };
      }

      case 'forget': {
        const id = params.id as string;
        if (!id) {
          throw new Error('id parameter is required for forget command');
        }
        // Try all stores
        for (const store of [this.stores.semantic, this.stores.episodic, this.stores.project]) {
          const deleted = await store.remove(id);
          if (deleted) {
            return { deleted: true, id };
          }
        }
        return { deleted: false, id };
      }

      case 'consolidate': {
        const semantic = await this.stores.semantic.getAll();
        if (semantic.length === 0) {
          return { before: 0, after: 0, removed: 0 };
        }
        const consolidated = await this.extractor.consolidate(semantic);
        await this.stores.semantic.replaceAll(consolidated, 'semantic');
        return {
          before: semantic.length,
          after: consolidated.length,
          removed: semantic.length - consolidated.length,
        };
      }

      default:
        throw new Error(`Unknown memory command: ${command}`);
    }
  }

  private getStoreForType(type: MemoryEntry['type']): MemoryStore {
    switch (type) {
      case 'semantic': return this.stores.semantic;
      case 'episodic': return this.stores.episodic;
      case 'project': return this.stores.project;
      default: return this.stores.semantic;
    }
  }
}
