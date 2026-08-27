import { topoSort } from "./graph.js";
import type { WorkflowDefinition } from "./types.js";

/** Minimal skeleton — full validation lands in Task 4. */
export function parseWorkflow(raw: unknown): WorkflowDefinition {
  return raw as WorkflowDefinition;
}
