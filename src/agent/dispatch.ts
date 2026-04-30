import type { ToolCall } from '../types';
import type { ToolImplementation } from '../types';

export interface ExecutionPlan {
  /** Waves are executed sequentially; tools within a wave run in parallel. */
  waves: ToolCall[][];
}

/**
 * Group tool calls into execution waves based on readonly/conflictKey metadata.
 *
 * Conservative strategy:
 * - Consecutive readonly tools are batched into a single parallel wave.
 * - Each non-readonly tool gets its own wave (one at a time).
 *
 * This covers the 90% win (multiple read_file/grep/glob/ls in parallel)
 * without risking write-write or read-write races.
 */
export function planExecution(
  calls: ToolCall[],
  lookup: (name: string) => ToolImplementation | undefined,
): ExecutionPlan {
  const waves: ToolCall[][] = [];
  let readonlyWave: ToolCall[] = [];

  const flushReadonly = () => {
    if (readonlyWave.length) {
      waves.push(readonlyWave);
      readonlyWave = [];
    }
  };

  for (const call of calls) {
    const tool = lookup(call.name);
    if (tool?.readonly) {
      readonlyWave.push(call);
      continue;
    }
    // Non-readonly: flush accumulated readonly wave, then single-tool wave
    flushReadonly();
    waves.push([call]);
  }
  flushReadonly();

  return { waves };
}
