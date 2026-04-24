import type { AgentContext, Middleware, AgentMiddleware } from '../types';
import type { Message } from '../types';
import type { MemoryStore, MemoryRetriever, MemoryExtractor, MemoryConfig } from './types';
import { getSettingsSync } from '../config';

// Fallback defaults if settings aren't loaded yet
const FALLBACK_MEMORY_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxSemanticEntries: 200,
  maxEpisodicEntries: 500,
  consolidationThreshold: 50,
  autoExtractMinToolCalls: 3,
  maxInjectedEntries: 10,
  extractionModel: 'claude-3-haiku-20240307',
};

// Get settings with fallback
function getMemoryConfig(): Required<MemoryConfig> {
  try {
    const settings = getSettingsSync();
    return settings.memory as unknown as Required<MemoryConfig>;
  } catch {
    return FALLBACK_MEMORY_CONFIG;
  }
}

export class MemoryMiddleware implements AgentMiddleware {
  private semanticStore: MemoryStore;
  private episodicStore: MemoryStore;
  private projectStore: MemoryStore;
  private retriever: MemoryRetriever;
  private extractor: MemoryExtractor;
  private config: Required<MemoryConfig>;
  private pendingExtractions: Promise<void>[] = [];

  constructor(
    stores: {
      semantic: MemoryStore;
      episodic: MemoryStore;
      project: MemoryStore;
    },
    retriever: MemoryRetriever,
    extractor: MemoryExtractor,
    config: MemoryConfig = {},
  ) {
    this.semanticStore = stores.semantic;
    this.episodicStore = stores.episodic;
    this.projectStore = stores.project;
    this.retriever = retriever;
    this.extractor = extractor;
    this.config = { ...getMemoryConfig(), ...config };
  }

  /**
   * Wait for all pending memory extractions to complete.
   * This ensures all memory is saved before process exit.
   */
  async awaitPendingExtractions(): Promise<void> {
    if (this.pendingExtractions.length === 0) return;
    await Promise.allSettled(this.pendingExtractions);
    // Clear completed extractions
    this.pendingExtractions = [];
  }

  beforeModel: Middleware = async (context, next) => {
    // Find last user message for query
    const lastUserMessage = findLastUserMessage(context.messages);
    if (!lastUserMessage) {
      return next();
    }

    const query = lastUserMessage.content;
    const projectPath = process.cwd();

    // Retrieve relevant memories
    const memories = await this.retriever.search(query, {
      limit: this.config.maxInjectedEntries,
      projectPath,
    });

    // Get project memory (already included in search results if exists)
    if (memories.length > 0) {
      const memoryBlock = this.formatMemories(memories);
      // Remove any existing memory block before adding new one
      let cleanedPrompt = context.systemPrompt || '';
      cleanedPrompt = cleanedPrompt.replace(/\n\n<memory>[\s\S]*?<\/memory>/, '');
      const newMemorySection = `\n\n<memory>\n${memoryBlock}\n</memory>`;
      context.systemPrompt = (cleanedPrompt + newMemorySection).trim();
    }

    return next();
  };

  afterAgentRun: Middleware = async (context, next) => {
    const result = await next();

    // Check trigger conditions for auto-extraction:
    // 1. Last response has no tool calls -> task completed
    // 2. Total tool calls >= threshold -> did meaningful work
    const lastResponse = findLastResponse(context.messages);
    if (!lastResponse || (lastResponse.tool_calls && lastResponse.tool_calls.length > 0)) {
      return result;
    }

    const toolCallCount = countToolCalls(context.messages);
    if (toolCallCount < this.config.autoExtractMinToolCalls) {
      return result;
    }

    // Trigger async extraction, don't block agent but track for graceful shutdown
    const projectPath = process.cwd();
    const extractionPromise = this.extractor.extract(context.messages, projectPath)
      .then(async newEntries => {
        for (const entry of newEntries) {
          switch (entry.type) {
            case 'semantic':
              await this.semanticStore.add(entry);
              break;
            case 'project':
              await this.projectStore.add(entry);
              break;
            case 'episodic':
            default:
              // Episodic goes to episodic store
              await this.episodicStore.add(entry);
              break;
          }
        }
      })
      .catch(err => {
        console.error('[memory] Auto-extraction failed:', err);
      })
      .finally(() => {
        // Remove from pending list when done
        const index = this.pendingExtractions.indexOf(extractionPromise);
        if (index >= 0) {
          this.pendingExtractions.splice(index, 1);
        }
      });

    this.pendingExtractions.push(extractionPromise);
    return result;
  };

  private formatMemories(memories: MemoryEntry[]): string {
    const semantic = memories.filter(m => m.type === 'semantic');
    const project = memories.find(m => m.type === 'project');
    const episodic = memories.filter(m => m.type === 'episodic')
      .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

    // Count how many we've used already
    let used = semantic.length + (project ? 1 : 0);
    const maxEpisodic = Math.max(0, this.config.maxInjectedEntries - used);
    const limitedEpisodic = episodic.slice(0, maxEpisodic);

    let blocks: string[] = [];

    if (semantic.length > 0) {
      blocks.push('## User Preferences (Relevant)\n' + semantic.map(m => `- ${m.text}`).join('\n'));
    }

    if (project) {
      const projectName = project.projectPath ? project.projectPath.split('/').pop() : 'Project';
      blocks.push(`## Current Project: ${projectName}\n${project.text}`);
    }

    if (limitedEpisodic.length > 0) {
      blocks.push('## Recent Work\n' + limitedEpisodic.map(m => {
        const date = m.created.split('T')[0];
        return `- ${date}: ${m.text}`;
      }).join('\n'));
    }

    return blocks.join('\n\n');
  }
}

// Helper functions
function findLastUserMessage(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(m => m.role === 'user');
}

function findLastResponse(messages: Message[]): Message | undefined {
  return [...messages].reverse().find(m => m.role === 'assistant');
}

function countToolCalls(messages: Message[]): number {
  return messages.filter(m => m.role === 'tool').length;
}
