// src/agent/sub-agent-tool.ts
import { nanoid } from 'nanoid';
import type { Tool, ToolImplementation } from '../types';
import type { Provider, AgentConfig, Message, AgentContext } from '../types';
import type { AgentEvent, AgentLoopConfig, AggregatedUsage } from './loop-types';
import { Agent } from './Agent';
import { ContextManager } from './context';
import { ToolRegistry } from './tool-registry';
import { DEFAULT_LOOP_CONFIG } from './loop-types';

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
    this.config = config;
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
- The subtask depends on information only available in the current conversation`,
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'A clear, self-contained task description. Include all necessary context or reference files the sub agent should read — it cannot see the current conversation.',
          },
        },
        required: ['task'],
      },
    };
  }

  /**
   * Execute the sub agent with the given task
   */
  async execute(
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; context: AgentContext },
  ): Promise<string> {
    const task = params.task as string;

    if (!task || typeof task !== 'string') {
      return 'Error: Missing required "task" parameter';
    }

    const agentId = `sub-${nanoid(6)}`;
    const startTime = Date.now();

    try {
      // Build filtered tool registry - exclude sub_agent to prevent recursion
      // Also exclude Task* tools because they use a global module-level taskStore
      // Sub agents don't need task tracking anyway for simple subtasks
      const subToolRegistry = new ToolRegistry();
      const mainTools = this.config.mainToolRegistry.getAllDefinitions();

      for (const toolDef of mainTools) {
        // Never allow sub_agent recursion
        if (toolDef.name === 'sub_agent') {
          continue;
        }
        // Exclude Task* tools - they use global state
        if (toolDef.name.startsWith('Task')) {
          continue;
        }
        // If allowedTools specified, filter to only those
        if (this.config.allowedTools && !this.config.allowedTools.includes(toolDef.name)) {
          continue;
        }
        // Get the actual implementation from main registry and re-register
        const impl = this.config.mainToolRegistry.get(toolDef.name);
        if (impl) {
          subToolRegistry.register(impl);
        }
      }

      // Create isolated context manager for sub agent
      const tokenLimit = this.config.tokenLimit ?? 50000;
      const subContextManager = new ContextManager({ tokenLimit });

      // Set up system prompt
      const systemPrompt = this.config.systemPromptTemplate ?? `You are a focused sub-agent executing a specific task.

You have your own independent context and full access to tools.
Your goal is to complete the task and provide a clear concise summary when done.
If the task references files in .agent/, read them first before proceeding.`;

      subContextManager.setSystemPrompt(systemPrompt);

      // Add the user task - done automatically by runAgentLoop

      // Create sub agent config
      const subAgentConfig: AgentConfig = {
        ...this.config.mainAgentConfig,
        tokenLimit,
      };

      // Use provided provider or inherit from main
      const provider = this.config.provider ?? this.config.mainProvider;

      // Create the sub agent
      const subAgent = new Agent({
        provider,
        contextManager: subContextManager,
        config: subAgentConfig,
        toolRegistry: subToolRegistry,
      });

      // Default loop config with tighter constraints
      const defaultSubLoopConfig: Partial<AgentLoopConfig> = {
        maxTurns: 15,
        timeoutMs: 5 * 60 * 1000, // 5 minutes
      };

      const loopConfig: AgentLoopConfig = {
        ...DEFAULT_LOOP_CONFIG,
        ...defaultSubLoopConfig,
        ...this.config.loopConfig,
      };

      // Bubble start event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_start',
          agentId,
          task,
          turnIndex: 0,
        });
      }

      let finalTotalTurns = 0;
      let finalSummary = '';
      let hasTimeoutError = false;
      let hasMaxTurnsError = false;

      // Run the agent loop and bubble events - propagate abort signal from main
      for await (const event of subAgent.runAgentLoop(
        { role: 'user', content: task },
        loopConfig,
        { signal: options?.signal }
      )) {
        // Check for abort from main (extra safety check)
        if (options?.signal?.aborted) {
          throw new Error('Sub agent aborted by main agent');
        }

        // Bubble the event if callback exists
        if (this.config.onEvent) {
          this.config.onEvent(agentId, {
            type: 'sub_agent_event',
            agentId,
            event,
            turnIndex: 0,
          });
        }

        // Track timeout errors
        if (event.type === 'agent_error' && event.error?.message.includes('aborted')) {
          hasTimeoutError = true;
        }

        // Capture the final summary from agent_done
        if (event.type === 'agent_done') {
          // Get the actual total turns from the event
          finalTotalTurns = event.totalTurns;

          // Check for max turns or timeout reasons
          if (event.reason === 'max_turns_reached') {
            hasMaxTurnsError = true;
          } else if (event.reason === 'error') {
            hasTimeoutError = true;
          }

          // Get the final context and find the last assistant message
          const finalContext = subAgent.getContext();

          // Search backwards from the end to find the last assistant message
          // Because the last message might be a tool result, not assistant
          for (let i = finalContext.messages.length - 1; i >= 0; i--) {
            const message = finalContext.messages[i];
            if (message.role === 'assistant' && message.content) {
              finalSummary = message.content;
              break;
            }
          }
        }
      }

      const durationMs = Date.now() - startTime;

      // Determine if the execution was aborted due to timeout or max turns
      let executionSummary = finalSummary;
      if (!executionSummary) {
        if (hasTimeoutError || durationMs >= loopConfig.timeoutMs) {
          executionSummary = 'SubAgent execution terminated: timeout after 5 minutes.';
        } else if (hasMaxTurnsError || finalTotalTurns >= loopConfig.maxTurns) {
          executionSummary = `SubAgent execution terminated: maximum ${loopConfig.maxTurns} turns reached.`;
        } else {
          executionSummary = `Sub agent completed ${finalTotalTurns} turns but produced no final summary.`;
        }
      }

      // If the execution took longer than the timeout, we should show the timeout summary even if we got a final summary
      if (durationMs >= loopConfig.timeoutMs) {
        executionSummary = 'SubAgent execution terminated: timeout after 5 minutes.';
      }

      // Bubble done event
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: executionSummary,
          totalTurns: finalTotalTurns,
          durationMs,
          isError: !finalSummary, // If we had to generate an error summary
          turnIndex: 0,
        });
      }

      // Return summary to main agent
      return `[SubAgent ${agentId} completed in ${durationMs}ms, ${finalTotalTurns} turns]\n\n${executionSummary}`;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorObj = error instanceof Error ? error : new Error(errorMessage);

      // Bubble done event with error status
      if (this.config.onEvent) {
        this.config.onEvent(agentId, {
          type: 'sub_agent_done',
          agentId,
          summary: errorMessage,
          totalTurns: 0,
          durationMs,
          isError: true,
          error: errorObj,
          turnIndex: 0,
        });
      }

      // Return error as normal tool result (don't throw) so main can handle it
      return `[SubAgent ${agentId} failed after ${durationMs}ms]\n\nError: ${errorMessage}`;
    }
  }
}