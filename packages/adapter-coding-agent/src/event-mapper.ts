/** Event/outcome mapping is part of the neutral wire contract (both sides of
 *  the stdio boundary map identically): re-exported from agent-backend. */

export type { TransportRunEvent } from "@my-agent-team/agent-backend";
export { mapRunEvent, mapRunOutcome } from "@my-agent-team/agent-backend";
