import type { AgentEvent } from '../../src/types';

export async function collectAgentEvents(
  gen: AsyncGenerator<AgentEvent>
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}
