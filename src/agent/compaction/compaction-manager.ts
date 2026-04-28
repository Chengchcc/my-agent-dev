import type { CompressionStrategy, AgentContext, Message } from '../../types';
import type { CompactionConfig, CompactionResult, TokenBudget } from './types';
import type { TokenBudgetCalculator } from './budget';
import { ToolOutputSnipStrategy } from './tiers/snip';
import { AutoCompactStrategy } from './tiers/auto-compact';
import { ReactiveRecoveryStrategy } from './tiers/reactive';
import { ContextCollapseStrategy } from './tiers/collapse';

/**
 * Tiered Compaction Manager - main orchestrator that implements the CompressionStrategy interface.
 *
 * Applies the lowest (least destructive) compression tier sufficient to get under budget:
 * - < 60%: No compression
 * - 60-75%: Tier 1 - Tool output snipping (truncate large outputs, keep head/tail)
 * - 75-95%: Tier 2 - Auto compact (LLLM summarize older messages, preserve recent)
 * - > 95%: Tier 4 - Context collapse (only system + summary + last 2 messages)
 *
 * Tier 3 (Reactive Recovery) is triggered externally when API returns context_length_exceeded.
 */
export class TieredCompactionManager implements CompressionStrategy {
  private budgetCalc: TokenBudgetCalculator;
  private snip: ToolOutputSnipStrategy;
  private autoCompact: AutoCompactStrategy;
  private reactive: ReactiveRecoveryStrategy;
  private collapse: ContextCollapseStrategy;
  private config: CompactionConfig;

  /** Last compaction result, for observability / TUI display */
  private lastResult: CompactionResult | null = null;

  constructor(
    budgetCalc: TokenBudgetCalculator,
    config: CompactionConfig,
  ) {
    this.budgetCalc = budgetCalc;
    this.config = config;
    this.snip = new ToolOutputSnipStrategy(config.thresholds);
    this.autoCompact = new AutoCompactStrategy(config.summaryProvider!, config);
    this.reactive = new ReactiveRecoveryStrategy();
    this.collapse = new ContextCollapseStrategy();
  }

  /**
   * Main entry point - implements CompressionStrategy.compress().
   * Called by ContextManager.compressIfNeeded().
   */
  async compress(context: AgentContext, tokenLimit: number): Promise<Message[]> {
    const result = await this.compressWithResult(context, tokenLimit);
    return result.messages;
  }

  /**
   * Compress and return full result with metadata.
   */
  async compressWithResult(context: AgentContext, _tokenLimit: number): Promise<CompactionResult> {
    const budget = this.budgetCalc.calculate(context);
    const preserveCount = this.config.thresholds.preserveRecentTurns;
    const thresholds = this.config.thresholds;

    // Below snip threshold - no compaction needed
    if (budget.usageRatio < thresholds.snipRatio) {
      const result: CompactionResult = {
        messages: context.messages,
        tier: 0,
        tokensBefore: budget.currentUsage,
        tokensAfter: budget.currentUsage,
        needsContinuation: false,
        level: 'none',
        compacted: false,
      };
      this.lastResult = result;
      return result;
    }

    // Tier 1: Snip tool outputs
    if (budget.usageRatio < thresholds.autoCompactRatio && this.config.enabledTiers.snip) {
      const result = this.snip.apply(context.messages, preserveCount);
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;

      // Check if snip was sufficient
      const newRatio = result.tokensAfter / budget.effectiveLimit;
      if (newRatio < thresholds.autoCompactRatio) {
        return result;
      }
      // Fall through to higher tier if snip wasn't enough
      context.messages = result.messages;
    }

    // Tier 2: Auto Compact (LLM summarization of older messages)
    if (budget.usageRatio < thresholds.collapseRatio && this.config.enabledTiers.autoCompact) {
      // Apply Tier 1 first if it's enabled, then Tier 2 on the snipped messages
      let workingMessages = context.messages;
      if (this.config.enabledTiers.snip) {
        const snippedResult = this.snip.apply(workingMessages, preserveCount);
        workingMessages = snippedResult.messages;
      }

      const result = await this.autoCompact.apply(
        { ...context, messages: workingMessages },
        preserveCount,
      );
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;
      return result;
    }

    // Tier 4: Context Collapse
    if (this.config.enabledTiers.collapse) {
      const result = this.collapse.apply(context.messages);
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;
      return result;
    }

    // All tiers disabled - return identity
    const result: CompactionResult = {
      messages: context.messages,
      tier: 0,
      tokensBefore: budget.currentUsage,
      tokensAfter: budget.currentUsage,
      needsContinuation: false,
      level: 'none',
      compacted: false,
    };
    this.lastResult = result;
    return result;
  }

  /**
   * Tier 3: Reactive recovery - called externally when API returns context_length_exceeded.
   * Does incremental rule-based compression without calling LLM.
   */
  async reactiveRecover(context: AgentContext): Promise<CompactionResult> {
    const budget = this.budgetCalc.calculate(context);

    // Phase 1: Try reactive (rule-based aggressive compression)
    const result = this.reactive.apply(
      context.messages,
      budget.effectiveLimit,
      (msgs) => this.budgetCalc.countMessages(msgs, context.systemPrompt),
    );

    if (result.needsContinuation && this.config.enabledTiers.collapse) {
      // Reactive wasn't enough - escalate to Tier 4
      return this.collapse.apply(result.messages);
    }

    result.tokensBefore = budget.currentUsage;
    result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
    this.lastResult = result;
    return result;
  }

  /** Get last compaction result for observability */
  getLastResult(): CompactionResult | null {
    return this.lastResult;
  }

  /** Get current budget snapshot (for TUI display or budget guard) */
  getBudget(context: AgentContext): TokenBudget {
    return this.budgetCalc.calculate(context);
  }
}
