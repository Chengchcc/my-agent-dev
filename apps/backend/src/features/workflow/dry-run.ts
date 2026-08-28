import {
  computeNext,
  parseWorkflow,
  routeOutgoing,
  type CompletionRecord,
  type WorkflowDefinition,
} from "@chengchenccc/workflow";

export interface DryRunStep {
  nodeId: string;
  output: Record<string, unknown>;
  routedTo: string[];
  order: number;
}

export interface DryRunResult {
  exit: string;
  steps: DryRunStep[];
  store: Record<string, unknown>;
}

export function dryRunWorkflow(
  rawDefinition: unknown,
  input: Record<string, unknown>,
  mockOutputs: Record<string, Record<string, unknown>>,
): DryRunResult {
  const def: WorkflowDefinition = parseWorkflow(rawDefinition);
  const store: Record<string, unknown> = {};
  const completions: CompletionRecord[] = [];
  const steps: DryRunStep[] = [];
  let order = 0;
  for (;;) {
    const step = computeNext(def, { completions, store, trigger: input });
    if (step.kind === "terminal") return { exit: step.exit, steps, store };
    if (step.kind === "idle") throw new Error("stuck: no ready nodes and no terminal");
    for (const ready of step.ready) {
      const node = ready.node;
      const output = node.type === "start" ? { ...input } : (mockOutputs[node.id] ?? {});
      const routedTo = routeOutgoing(node.id, def, completions, store, output);
      completions.push({ nodeId: node.id, output, order, routedTo });
      steps.push({ nodeId: node.id, output, routedTo, order });
      order++;
    }
  }
}
