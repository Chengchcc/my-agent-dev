import { ZodTool } from '../tools/zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { z } from 'zod';
import type { MemoryEntry, MemoryStore, MemoryRetriever, MemoryExtractor } from './types';

export class MemoryTool extends ZodTool<z.ZodObject<{
  command: z.ZodEnum<['search', 'add', 'list', 'forget', 'consolidate']>;
  query: z.ZodOptional<z.ZodString>;
  text: z.ZodOptional<z.ZodString>;
  id: z.ZodOptional<z.ZodString>;
  type: z.ZodOptional<z.ZodEnum<['semantic', 'episodic', 'project']>>;
  limit: z.ZodOptional<z.ZodNumber>;
}>> {
  protected readonly name = 'memory';
  protected readonly description = `Read, write, or search persistent memory across conversations. Use to remember user preferences, project facts, and important decisions.

Commands:
- search: Find relevant memories for a query
- add: Store a new reusable memory
- list: List recent memories (optionally filter by type)
- forget: Remove a specific memory by ID
- consolidate: Trigger deduplication/consolidation of semantic memory

Only store genuinely reusable information that will be useful in future conversations. Do not store transient conversation details.`;

  protected schema = z.object({
    command: z.enum(['search', 'add', 'list', 'forget', 'consolidate']),
    query: z.string().optional(),
    text: z.string().optional(),
    id: z.string().optional(),
    type: z.enum(['semantic', 'episodic', 'project']).optional(),
    limit: z.number().optional(),
  });

  constructor(
    private stores: {
      semantic: MemoryStore;
      episodic: MemoryStore;
      project: MemoryStore;
    },
    private retriever: MemoryRetriever,
    private extractor: MemoryExtractor,
  ) {
    super();
  }

  protected async handle(params: z.infer<typeof this.schema>, _ctx: ToolContext): Promise<unknown> {
    const command = params.command;
    const projectPath = process.cwd();

    switch (command) {
      case 'search': {
        const query = params.query;
        const limit = params.limit || 10;
        if (!query) {
          throw new Error('query parameter is required for search command');
        }
        const results = await this.retriever.search(query, { limit, projectPath });
        return { results };
      }

      case 'add': {
        const text = params.text;
        const type = (params.type as MemoryEntry['type']) || 'semantic';
        if (!text) {
          throw new Error('text parameter is required for add command');
        }
        const store = this.getStoreForType(type);
        const entry: any = { type, text, weight: 1.0, source: 'explicit' };
        if (type === 'project') entry.projectPath = projectPath;
        const added = await store.add(entry);
        return { added };
      }

      case 'list': {
        const type = params.type as MemoryEntry['type'] | undefined;
        const limit = params.limit || 10;
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
        const id = params.id;
        if (!id) {
          throw new Error('id parameter is required for forget command');
        }
        // Try all stores
        for (const [type, store] of [
          ['semantic', this.stores.semantic] as const,
          ['episodic', this.stores.episodic] as const,
          ['project', this.stores.project] as const,
        ]) {
          const deleted = await store.remove(id);
          if (deleted) {
            return { deleted: true, id, type };
          }
        }
        return { deleted: false, id };
      }

      case 'consolidate': {
        const type = (params.type as MemoryEntry['type']) || 'semantic';
        const store = this.getStoreForType(type);
        const entries = await store.getAll();
        if (entries.length === 0) {
          return { before: 0, after: 0, removed: 0 };
        }
        const consolidated = await this.extractor.consolidate(entries);
        await store.replaceAll(consolidated, type);
        return {
          before: entries.length,
          after: consolidated.length,
          removed: entries.length - consolidated.length,
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
