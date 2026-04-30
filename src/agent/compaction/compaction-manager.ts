import type { CompressionStrategy, AgentContext, Message } from '../../types';
import type { CompactionConfig, CompactionResult, TokenBudget } from './types';
import { CompactionTier } from './types';
import type { TokenBudgetCalculator } from './budget';
import { ToolOutputSnipStrategy } from './tiers/snip';
import { AutoCompactStrategy } from './tiers/auto-compact';
import { ReactiveRecoveryStrategy } from './tiers/reactive';
import { ContextCollapseStrategy } from './tiers/collapse';
import { debugLog } from '../../utils/debug';

const TO_FIXED_PRECISION = 3;

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
        tier: CompactionTier.None,
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
        debugLog({
          event: 'compaction.triggered',
          tier: 'snip',
          tierNumber: CompactionTier.Snip,
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
          reduction: result.tokensBefore - result.tokensAfter,
          messageCountBefore: context.messages.length,
          messageCountAfter: result.messages.length,
          budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio, newRatio },
        });
        return result;
      }
      // Snip wasn't enough - log and fall through
      debugLog({
        event: 'compaction.triggered',
        tier: 'snip',
        tierNumber: CompactionTier.Snip,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        reduction: result.tokensBefore - result.tokensAfter,
        escalated: true,
        reason: `snip insufficient (ratio ${newRatio.toFixed(TO_FIXED_PRECISION)} >= ${thresholds.autoCompactRatio})`,
      });
      context.messages = result.messages;
    }

    // Tier 2: Auto Compact (LLM summarization of older messages)
    if (budget.usageRatio < thresholds.collapseRatio && this.config.enabledTiers.autoCompact) {
      // Apply snip if Tier 1 didn't already do it (we entered Tier 2 directly,
      // meaning usageRatio was already >= autoCompactRatio so Tier 1 was skipped).
      let workingMessages = context.messages;
      if (this.config.enabledTiers.snip && budget.usageRatio >= thresholds.autoCompactRatio) {
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
      debugLog({
        event: 'compaction.triggered',
        tier: 'auto-compact',
        tierNumber: CompactionTier.AutoCompact,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        reduction: result.tokensBefore - result.tokensAfter,
        messageCountBefore: context.messages.length,
        messageCountAfter: result.messages.length,
        budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
      });
      return result;
    }

    // Tier 3: Reactive Recovery (rule-based aggressive snipping, no LLM call)
    // Reached when Tier 2 was skipped (usageRatio >= collapseRatio) or Tier 2 wasn't enough.
    // More aggressive than Tier 2 but cheaper — no LLM summarization.
    if (budget.usageRatio >= thresholds.collapseRatio && this.config.enabledTiers.reactiveRecovery) {
      const ctx = { ...context, messages: context.messages };
      const result = this.reactive.apply(
        ctx.messages,
        budget.effectiveLimit,
        (msgs) => this.budgetCalc.countMessages(msgs, ctx.systemPrompt),
      );
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;
      debugLog({
        event: 'compaction.triggered',
        tier: 'reactive',
        tierNumber: CompactionTier.Reactive,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        reduction: result.tokensBefore - result.tokensAfter,
        messageCountBefore: context.messages.length,
        messageCountAfter: result.messages.length,
        budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
      });
      return result;
    }

    // Tier 4: Context Collapse (nuclear option)
    if (this.config.enabledTiers.collapse) {
      const result = this.collapse.apply(context.messages);
      result.tokensBefore = budget.currentUsage;
      result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
      this.lastResult = result;
      debugLog({
        event: 'compaction.triggered',
        tier: 'collapse',
        tierNumber: CompactionTier.Collapse,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        reduction: result.tokensBefore - result.tokensAfter,
        messageCountBefore: context.messages.length,
        messageCountAfter: result.messages.length,
        budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
      });
      return result;
    }

    // All tiers disabled - return identity
    const result: CompactionResult = {
      messages: context.messages,
      tier: CompactionTier.None,
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
      debugLog({
        event: 'compaction.triggered',
        tier: 'reactive',
        tierNumber: CompactionTier.Reactive,
        tokensBefore: budget.currentUsage,
        escalated: true,
        reason: 'reactive insufficient, escalating to collapse',
      });
      const collapseResult = this.collapse.apply(result.messages);
      collapseResult.tokensBefore = budget.currentUsage;
      collapseResult.tokensAfter = this.budgetCalc.countMessages(collapseResult.messages, context.systemPrompt);
      this.lastResult = collapseResult;
      debugLog({
        event: 'compaction.triggered',
        tier: 'collapse',
        tierNumber: CompactionTier.Collapse,
        tokensBefore: collapseResult.tokensBefore,
        tokensAfter: collapseResult.tokensAfter,
        reduction: collapseResult.tokensBefore - collapseResult.tokensAfter,
        messageCountBefore: context.messages.length,
        messageCountAfter: collapseResult.messages.length,
        budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
        trigger: 'reactive-escalation',
      });
      return collapseResult;
    }

    result.tokensBefore = budget.currentUsage;
    result.tokensAfter = this.budgetCalc.countMessages(result.messages, context.systemPrompt);
    this.lastResult = result;
    debugLog({
      event: 'compaction.triggered',
      tier: 'reactive',
      tierNumber: CompactionTier.Reactive,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      reduction: result.tokensBefore - result.tokensAfter,
      messageCountBefore: context.messages.length,
      messageCountAfter: result.messages.length,
      budget: { effectiveLimit: budget.effectiveLimit, usageRatio: budget.usageRatio },
    });
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
