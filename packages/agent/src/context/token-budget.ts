import type { Message } from "@my-agent-team/message";
import { repairToolPairs } from "../runtime/repair-tool-pairs.js";
import type { ContextManager } from "./context-manager.js";

export interface TokenBudgetOptions {
  maxTokens: number;
  reserveForOutput?: number;
  countTokens?: (messages: readonly Message[]) => number | Promise<number>;
}

const APPROX_CHARS_PER_TOKEN = 4;

function approximateTokens(messages: readonly Message[]): number {
  return Math.ceil(JSON.stringify(messages).length / APPROX_CHARS_PER_TOKEN);
}

export function tokenBudgetContextManager(opts: TokenBudgetOptions): ContextManager {
  const reserve = opts.reserveForOutput ?? 4096;
  const budget = opts.maxTokens - reserve;

  return {
    async shape(ctx, messages) {
      const counter = opts.countTokens ?? ctx.model.countTokens ?? approximateTokens;

      const msgs = [...messages];
      let total = await counter(msgs);

      if (total <= budget) return msgs;

      const kept: Message[] = [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (!msg) continue;
        kept.unshift(msg);
        total = await counter(kept);
        if (total > budget) {
          kept.shift();
          break;
        }
      }

      return repairToolPairs(kept);
    },
  };
}
