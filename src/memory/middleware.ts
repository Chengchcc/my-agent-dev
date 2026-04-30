import type { Middleware, AgentMiddleware } from '../types';
import type { Message } from '../types';
import type { MemoryStore, MemoryRetriever, MemoryExtractor, MemoryConfig } from './types';
import { getSettingsSync } from '../config';
import { loadAgentMdCached } from './agent-md';
import { djb2Hash } from '../utils/hash';

// Fallback defaults if settings aren't loaded yet
const FALLBACK_MAX_SEMANTIC_ENTRIES = 200;
const FALLBACK_MAX_EPISODIC_ENTRIES = 500;
const FALLBACK_CONSOLIDATION_THRESHOLD = 50;
const FALLBACK_AUTO_EXTRACT_MIN_TOOL_CALLS = 3;
const FALLBACK_MAX_INJECTED_ENTRIES = 10;
const FALLBACK_RETRIEVAL_THRESHOLD = 0.75;
const FALLBACK_RETRIEVAL_TOP_K = 5;
const FALLBACK_MAX_USER_PREFERENCES = 20;

const POST_COLLAPSE_RETRIEVAL_MULTIPLIER = 2;
const POST_COLLAPSE_PROJECT_MULTIPLIER = 2;
const RECENT_USER_TURN_COUNT = 3;

const FALLBACK_MEMORY_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxSemanticEntries: FALLBACK_MAX_SEMANTIC_ENTRIES,
  maxEpisodicEntries: FALLBACK_MAX_EPISODIC_ENTRIES,
  consolidationThreshold: FALLBACK_CONSOLIDATION_THRESHOLD,
  autoExtractMinToolCalls: FALLBACK_AUTO_EXTRACT_MIN_TOOL_CALLS,
  maxInjectedEntries: FALLBACK_MAX_INJECTED_ENTRIES,
  extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: FALLBACK_RETRIEVAL_THRESHOLD,
  retrievalTopK: FALLBACK_RETRIEVAL_TOP_K,
  extractTriggerMode: 'explicit',
  maxUserPreferences: FALLBACK_MAX_USER_PREFERENCES,
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
    // Strip previous memory-managed sections from system prompt (they'll be re-added below).
    const stripMemorySections = (prompt: string): string =>
      prompt.replace(
        /\n\n<(?:project_rules|user_preferences)[^>]*>[\s\S]*?<\/(?:project_rules|user_preferences)>/g,
        '',
      ).trim();

    const base = stripMemorySections(context.systemPrompt || '');

    // Layer 1: AGENT.md — stable project rules with mtime-based version for cache-busting
    const { merged: agentMd, version: rulesVersion } = await loadAgentMdCached();

    // Layer 2: User preferences from semantic store — stable section with content-hash version
    const allPrefs = await this.semanticStore.getAll();
    const topPrefs = allPrefs.slice(0, this.config.maxUserPreferences);
    const prefsText = topPrefs.map(p => `- ${p.text}`).join('\n');
    const prefsVersion = djb2Hash(prefsText);

    // Build stable system-extra sections
    const sections: string[] = [];
    if (agentMd) {
      sections.push(`<project_rules version="${rulesVersion}">\n${agentMd}\n</project_rules>`);
    }
    if (prefsText) {
      sections.push(`<user_preferences version="${prefsVersion}">\n${prefsText}\n</user_preferences>`);
    }
    if (sections.length > 0) {
      context.systemPrompt = [base, ...sections].filter(Boolean).join('\n\n');
    }

    // Layer 3: Episodic + project recall by query → ephemeral reminder (does NOT touch system prompt)
    const lastUserMessage = findLastUserMessage(context.messages);
    const isPostCollapse = !!context.metadata.justCollapsed;
    if (lastUserMessage) {
      const retrievalThreshold = isPostCollapse ? 0 : this.config.retrievalThreshold;
      const retrievalLimit = isPostCollapse ? this.config.retrievalTopK * POST_COLLAPSE_RETRIEVAL_MULTIPLIER : this.config.retrievalTopK;

      const hits = await this.retriever.search(lastUserMessage.content, {
        limit: retrievalLimit,
        projectPath: process.cwd(),
        type: 'episodic',
        threshold: retrievalThreshold,
      });
      // Also search project entries separately
      const projectHits = await this.retriever.search(lastUserMessage.content, {
        limit: isPostCollapse ? POST_COLLAPSE_PROJECT_MULTIPLIER : 1,
        projectPath: process.cwd(),
        type: 'project',
        threshold: retrievalThreshold,
      });

      if (isPostCollapse) {
        context.metadata.justCollapsed = false;
      }
      const allHits = [...projectHits, ...hits].slice(0, this.config.maxInjectedEntries);

      if (allHits.length > 0) {
        const body = allHits.map(h => {
          const date = h.created.split('T')[0];
          return `- (${date}) ${h.text}`;
        }).join('\n');
        context.ephemeralReminders ??= [];
        context.ephemeralReminders.push(
          `<system-reminder>\n<retrieved_memory>\n${body}\n</retrieved_memory>\n</system-reminder>`,
        );
        // Update lastHitAt for LRU eviction tracking
        this.episodicStore.markHit?.(allHits.map(h => h.id));
        this.projectStore.markHit?.(projectHits.map(h => h.id));
      }
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

    // Trigger-word gate: in 'explicit' mode, only extract when user said trigger words
    if (this.config.extractTriggerMode === 'off') {
      return result;
    }
    if (this.config.extractTriggerMode === 'explicit' && !shouldExtractFromMessages(context.messages)) {
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
              await this.episodicStore.add(entry);
              break;
          }
        }
        // Enforce capacity limits after adding new entries
        await this.semanticStore.enforceLimit?.();
        await this.episodicStore.enforceLimit?.();
      })
      .catch(err => {
        console.error('[memory] Auto-extraction failed:', err);
      })
      .finally(() => {
        // Remove from pending list when done
        const index = this.pendingExtractions.indexOf(extractionPromise);
        if (index >= 0) {
          void this.pendingExtractions.splice(index, 1);
        }
      });

    this.pendingExtractions.push(extractionPromise);
    return result;
  };

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


// Trigger words for explicit extraction mode — only extract when user uses these
const WRITE_TRIGGERS = [
  /记住/, /remember/i, /from now on/i, /always/i, /never/i,
  /我喜欢/, /我习惯/, /I prefer/i, /I like/i,
  /别再/, /don't/i, /stop doing/i,
  /保存这个/, /save this/i, /记录下来/, /note this/i,
];

function shouldExtractFromMessages(messages: Message[]): boolean {
  const userTurns = messages.filter(m => m.role === 'user');
  const recent = userTurns.slice(-RECENT_USER_TURN_COUNT).map(m => m.content).join('\n');
  return WRITE_TRIGGERS.some(re => re.test(recent));
}
