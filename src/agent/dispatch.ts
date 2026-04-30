import type { ToolCall } from '../types';
import type { ToolImplementation } from '../types';

export interface ExecutionPlan {
  /** Waves are executed sequentially; tools within a wave run in parallel. */
  waves: ToolCall[][];
}

/**
 * Group tool calls into execution waves based on readonly/conflictKey metadata.
 *
 * Strategy (first applicable wins):
 * 1. If conflictKey returns null → tool has no conflicts, can batch with others.
 * 2. If conflictKey returns a string → tool must run in its own wave.
 * 3. If no conflictKey defined: readonly tools batch, non-readonly get own wave.
 *
 * This enables sub_agent(read_only) to run in parallel with read_file/grep/glob.
 */
export function planExecution(
  calls: ToolCall[],
  lookup: (name: string) => ToolImplementation | undefined,
): ExecutionPlan {
  const waves: ToolCall[][] = [];
  let currentWave: ToolCall[] = [];

  const flush = () => {
    if (currentWave.length) {
      waves.push(currentWave);
      currentWave = [];
    }
  };

  for (const call of calls) {
    const tool = lookup(call.name);
    const conflict = resolveConflict(call, tool);

    if (conflict === null) {
      // No conflict — safe to batch with current wave
      currentWave.push(call);
    } else {
      // Has conflict — flush any accumulated wave, then this call alone
      flush();
      waves.push([call]);
    }
  }
  flush();

  return { waves };
}

/**
 * Resolve conflict for a single tool call.
 * Returns null (no conflict, safe to batch) or a string key (needs own wave).
 */
function resolveConflict(call: ToolCall, tool?: ToolImplementation): string | null {
  // If tool defines conflictKey, it takes precedence
  if (tool?.conflictKey) {
    try {
      return tool.conflictKey(call.arguments);
    } catch {
      return call.name; // Parse error → play it safe
    }
  }
  // Default: readonly tools are conflict-free, others get own wave
  return tool?.readonly ? null : call.name;
}
