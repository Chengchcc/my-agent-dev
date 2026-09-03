import type { StreamRule } from "./agent-loop-types.js";

export function safeParseJson(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** First stream rule matching `text` that still has injection budget.
 * ponytail: full re-scan per text delta (O(deltas × rules × len)); anchor
 * incremental matching if long generations measurably regress. */
export function matchStreamRule(
  rules: readonly StreamRule[],
  text: string,
  injections: ReadonlyMap<string, number>,
): StreamRule | undefined {
  for (const rule of rules) {
    if ((injections.get(rule.name) ?? 0) >= (rule.maxInjections ?? 1)) continue;
    if (rule.pattern.test(text)) return rule;
  }
  return undefined;
}

export const TOOL_FAILURE_REMINDER = [
  "<system-reminder>",
  "This tool call FAILED. Do not proceed as if it succeeded or claim it worked.",
  "Diagnose the error below; if the cause is fixable (wrong arguments, missing file, transient state), correct it and call the tool again. Only move on if the failure is genuinely permanent, and say so.",
  "</system-reminder>",
].join("\n");
