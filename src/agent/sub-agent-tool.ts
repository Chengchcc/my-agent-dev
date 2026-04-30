// src/agent/sub-agent-tool.ts
import { nanoid } from 'nanoid';
import type { Tool, ToolImplementation } from '../types';
import type { Provider, AgentConfig, AgentHooks } from '../types';
import type { ToolContext } from './tool-dispatch/types';
import type { AgentEvent, AgentLoopConfig, SubAgentExitStatus } from './loop-types';
import { Agent } from './Agent';
import { ContextManager } from './context';
import { ToolRegistry } from './tool-registry';
import { DEFAULT_LOOP_CONFIG } from './loop-types';
import { getSettingsSync } from '../config';
import { RateLimitedProvider } from './rate-limiter';

/** Sub-agent execution profile controlling tool access and parallelism. */
export type SubAgentProfile = 'read_only' | 'code_editor' | 'general';

/** Deliverable format for sub-agent output. */
export type SubAgentDeliverable = 'summary' | 'file_list' | 'code_patch' | 'structured_json';


/** Tool allowlists per profile. */
const PROFILE_TOOLS: Record<SubAgentProfile, string[]> = {
  read_only: ['read', 'grep', 'glob', 'ls'],
  code_editor: ['read', 'grep', 'glob', 'ls', 'text_editor', 'bash'],
  general: [], // empty = all non-excluded (no profile filter applied)
};

/** Tools always excluded from sub-agents regardless of profile. */
const ALWAYS_EXCLUDE = new Set(['sub_agent', 'ask_user_question']);

/** Tools excluded because they use global module-level state. */
const GLOBAL_STATE_TOOLS_PREFIX = 'Task';

/** Maximum concurrent sub-agents (sempahore-based). */
const MAX_CONCURRENT_SUB_AGENTS = 3;

/**
 * Simple promise-based semaphore for limiting concurrent sub-agent execution.
 */
class Semaphore {
  private count: number;
  private queue: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return;
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

const subAgentSemaphore = new Semaphore(MAX_CONCURRENT_SUB_AGENTS);

/**
 * Configuration for SubAgentTool
 */
export interface SubAgentToolConfig {
  /** The main agent's provider - sub agent inherits this if not overridden */
  mainProvider: Provider;
  /** The main agent's tool registry - used as base for filtered registry */
  mainToolRegistry: ToolRegistry;
  /** Main agent's config - token limit is used as base */
  mainAgentConfig: AgentConfig;
  /** List of allowed tools for sub agent - if empty, inherits all except sub_agent */
  allowedTools?: string[];
  /** Override the provider for this sub agent */
  provider?: Provider;
  /** Override loop configuration */
  loopConfig?: Partial<AgentLoopConfig>;
  /** Custom system prompt template */
  systemPromptTemplate?: string;
  /** Callback for bubbling events up to UI */
  onEvent?: (agentId: string, event: AgentEvent) => void;
  /** Maximum token limit for sub agent context (default: 50000) */
  tokenLimit?: number;
  /** AbortSignal from the main agent's execution - propagated to sub agent */
  signal?: AbortSignal;
  /** Auto trigger threshold for sub agent (default from settings) */
  autoTriggerThreshold?: number;
  /** Isolation mode for sub agent (default from settings) */
  isolation?: boolean;
  /** Worktree root directory for sub agent (default from settings) */
  worktreeRootDir?: string;
  /** Inherited hooks from main agent (e.g. beforeModel for memory/skills/todo) */
  hooks?: Partial<Pick<AgentHooks, 'beforeModel'>>;
}

/**
 * SubAgentTool - delegate a self-contained subtask to an independent agent
 * with its own isolated context.
 *
 * Uses the existing Agent architecture - no changes needed to Agent class.
 */
export class SubAgentTool implements ToolImplementation {
  private config: SubAgentToolConfig;

  constructor(config: SubAgentToolConfig) {
    try {
      const settings = getSettingsSync();
      this.config = {
        autoTriggerThreshold: settings.subAgent.autoTriggerThreshold,
        isolation: settings.subAgent.isolation,
        worktreeRootDir: settings.subAgent.worktreeRootDir,
        ...config,
      };
    } catch {
      // If settings not loaded (e.g. in test environments), use hardcoded defaults
      this.config = {
        autoTriggerThreshold: 5,
        isolation: true,
        worktreeRootDir: '~/.my-agent/worktrees',
        ...config,
      };
    }
  }

  /**
   * Get the tool definition for function calling
   */
  getDefinition(): Tool {
    return {
      name: 'sub_agent',
      description: `Delegate a self-contained subtask to an independent agent with its own isolated context.

USE when:
- The subtask needs to read/process many files but the caller only needs a summary
- The subtask requires different expertise (analysis vs coding vs testing)
- Running the subtask inline would bloat the current context with intermediate outputs

DO NOT USE when:
- A single tool call (bash/text_editor) can accomplish the task
- You need to interactively refine the result with the user
- The subtask depends on information only available in the current conversation

PROFILES:
- read_only: Only read/analysis tools. Safe to run in parallel with other sub-agents.
- code_editor: Read + write tools. Filesystem writes are serialized.
- general: All non-dangerous tools. Default if not specified.`,
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: 'The precise objective in one sentence.',
          },
          context: {
            type: 'string',
            description: 'Relevant findings, files already inspected, or information the sub-agent needs.',
          },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific constraints the sub-agent must follow (e.g. "do not edit files", "use only grep").',
          },
          deliverable: {
            type: 'string',
            enum: ['summary', 'file_list', 'code_patch', 'structured_json'],
            description: 'Expected output format. summary=free text, file_list=list of file paths, code_patch=diff/patch, structured_json=JSON matching output_schema.',
          },
          output_schema: {
            type: 'string',
            description: 'JSON schema for the output when deliverable=structured_json.',
          },
          profile: {
            type: 'string',
            enum: ['read_only', 'code_editor', 'general'],
            description: 'Execution profile controlling tool access. Default: read_only (safest, can parallelize).',
          },
        },
        required: ['goal', 'deliverable'],
      },
    };
  }

  get readonly(): boolean {
    return false; // conflictKey drives parallelism; sub-agent may write files
  }

  conflictKey(input: unknown): string | null {
    const params = input as Record<string, unknown>;
    const profile = (params.profile as SubAgentProfile) ?? 'read_only';
    if (profile === 'read_only') return null; // Safe to parallelize
    if (profile === 'code_editor') return 'fs:global'; // All writes serialized
    return 'agent:global'; // General profile: full serialization
  }

  /**
   * Execute the sub agent with the given task
   */
   
  // eslint-disable-next-line complexity, max-lines-per-function
  async execute(
    params: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    const goal = params.goal as string;
    const contextInfo = (params.context as string) ?? '';
    const constraints = (params.constraints as string[]) ?? [];
    const deliverable = (params.deliverable as SubAgentDeliverable) ?? 'summary';
    const outputSchema = (params.output_schema as string) ?? '';
    const profile = (params.profile as SubAgentProfile) ?? 'read_only';
    const signal = ctx.signal;

    if (!goal || typeof goal !== 'string') {
      return '<sub_agent_result status="error">Error: Missing required "goal" parameter</sub_agent_result>';
    }

    // Prevent recursion: only main agent can spawn sub_agent
    if (ctx.environment.agentType === 'sub_agent') {
      return '<sub_agent_result status="error">Error: sub_agent cannot spawn another sub_agent</sub_agent_result>';
    }

    const agentId = `sub-${nanoid(6)}`;
    const startTime = Date.now();

    // ── All synchronous setup (no I/O) before semaphore ──

    // Build filtered tool registry using profile-based allowlist
    const subToolRegistry = new ToolRegistry();
    const mainTools = this.config.mainToolRegistry.getAllDefinitions();
    const allowedSet = this.config.allowedTools
      ? new Set(this.config.allowedTools)
      : null;
    const profileSet = PROFILE_TOOLS[profile];
    // empty profileSet (general) means "allow all non-excluded"
    const useProfileFilter = profileSet.length > 0;

    for (const toolDef of mainTools) {
      // Always exclude recursion and dangerous tools
      if (ALWAYS_EXCLUDE.has(toolDef.name)) continue;
      // Exclude global-state tools
      if (toolDef.name.startsWith(GLOBAL_STATE_TOOLS_PREFIX)) continue;
      // If explicit allowedTools, filter to only those
      if (allowedSet && !allowedSet.has(toolDef.name)) continue;
      // Profile-based filtering
      if (useProfileFilter && !profileSet.includes(toolDef.name)) continue;

      const impl = this.config.mainToolRegistry.get(toolDef.name);
      if (impl) {
        subToolRegistry.register({
          getDefinition: () => toolDef,
          execute: (p, c) => impl.execute(p, c),
        });
      }
    }

    // Build system prompt (middleware handles project_rules/user_preferences/skill_catalog injection)
    const tokenLimit = this.config.tokenLimit ?? 50000;

    const systemPromptSections = [
      'You are a focused sub-agent executing a specific task with your own independent context.',
      'Complete the task and return a clear, structured result. Do NOT ask the user questions.',
      `<environment>\n  cwd: ${ctx.environment.cwd}\n</environment>`,
    ];
    const systemPrompt = systemPromptSections.filter(Boolean).join('\n\n');

    const subContextManager = new ContextManager({
      tokenLimit,
      defaultSystemPrompt: systemPrompt,
    });
    subContextManager.setSystemPrompt(systemPrompt);

    // Build structured task message
    const constraintsXml = constraints.length > 0
      ? `\n<constraints>\n${constraints.map(c => `- ${c}`).join('\n')}\n</constraints>`
      : '';
    const schemaXml = outputSchema
      ? `\n<output_schema>\n${outputSchema}\n</output_schema>`
      : '';
    const userMessage = `<task>
<goal>${goal}</goal>
<context>${contextInfo || 'none'}</context>${constraintsXml}
<deliverable type="${deliverable}">${schemaXml}
</deliverable>
</task>`;

    // Create sub agent config
    const subAgentConfig: AgentConfig = {
      ...this.config.mainAgentConfig,
      tokenLimit,
    };

    // Use provided provider or inherit from main, wrapped with rate limiting + log prefix
    const rawProvider = this.config.provider ?? this.config.mainProvider;
    const provider = new RateLimitedProvider(rawProvider, { prefix: agentId });

    // Create the sub agent with inherited hooks (memory, skills, todo)
    const subAgent = new Agent({
      provider,
      contextManager: subContextManager,
      config: subAgentConfig,
      toolRegistry: subToolRegistry,
      ...(this.config.hooks ? { hooks: this.config.hooks } : {}),
    });

    // Default loop config with tighter constraints
    const defaultSubLoopConfig: Partial<AgentLoopConfig> = {
      maxTurns: 15,
      timeoutMs: 5 * 60 * 1000, // 5 minutes default timeout
    };

    const loopConfig: AgentLoopConfig = {
      ...DEFAULT_LOOP_CONFIG,
      ...defaultSubLoopConfig,
      ...this.config.loopConfig,
    };

    // ── Semaphore guards only the agent loop execution ──

    try {
      await subAgentSemaphore.acquire();

      // Per-sub-agent abort controller (propagates from parent signal)
      const childAC = new AbortController();
      const onParentAbort = () => childAC.abort();
      signal.addEventListener('abort', onParentAbort, { once: true });

      // Bubble start event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_start',
          agentId,
          task: goal,
          turnIndex: 0,
        });
      }

      let finalTotalTurns = 0;
      let finalSummary = '';
      let exitStatus: SubAgentExitStatus = 'success';

      // Run agent loop with child abort signal
      try {
        for await (const event of subAgent.runAgentLoop(
          { role: 'user', content: userMessage },
          loopConfig,
          { signal: childAC.signal },
        )) {
          // Bubble the event if callback exists
          if (this.config.onEvent) {
            this.config.onEvent(agentId, {
              type: 'sub_agent_event',
              agentId,
              event,
              turnIndex: event.turnIndex,
            });
          }

          // Track the completion reason from agent_done
          if (event.type === 'agent_done') {
            finalTotalTurns = event.totalTurns;

            if (event.reason === 'max_turns_reached') {
              exitStatus = 'max_turns';
            } else if (event.reason === 'error' && event.error) {
              finalSummary = event.error.message;
              exitStatus = signal.aborted ? 'aborted' : 'error';
            }

            if (!finalSummary) {
              const finalCtx = subAgent.getContext();
              for (let i = finalCtx.messages.length - 1; i >= 0; i--) {
                const msg = finalCtx.messages[i];
                if (msg && msg.role === 'assistant' && msg.content) {
                  finalSummary = msg.content;
                  break;
                }
              }
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', onParentAbort);
      }

      const durationMs = Date.now() - startTime;

      // Determine exit status and summary
      if (!finalSummary) {
        if (signal.aborted) {
          exitStatus = 'aborted';
          finalSummary = 'Sub-agent aborted by main agent.';
        } else if (durationMs >= loopConfig.timeoutMs) {
          exitStatus = 'timeout';
          finalSummary = `Sub-agent timed out after ${loopConfig.timeoutMs / 1000 / 60} minutes.`;
        } else if (exitStatus === 'max_turns') {
          finalSummary = `Sub-agent reached maximum ${loopConfig.maxTurns} turns.`;
        } else {
          finalSummary = `Sub-agent completed ${finalTotalTurns} turns but produced no summary.`;
        }
      }

      // Bubble done event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: finalSummary,
          totalTurns: finalTotalTurns,
          durationMs,
          isError: exitStatus !== 'success',
          exitStatus,
          turnIndex: 0,
        });
      }

      // Return machine-readable wrapped result
      return `<sub_agent_result agent_id="${agentId}" turns="${finalTotalTurns}" duration_ms="${durationMs}" status="${exitStatus}">
${finalSummary}
</sub_agent_result>`;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);

      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: errorMessage,
          totalTurns: 0,
          durationMs,
          isError: true,
          error: errorObj,
          exitStatus: 'error',
          turnIndex: 0,
        });
      }

      return `<sub_agent_result agent_id="${agentId}" turns="0" duration_ms="${durationMs}" status="error">
Error: ${errorMessage}
</sub_agent_result>`;
    } finally {
      subAgentSemaphore.release();
    }
  }
}