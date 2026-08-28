import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, type WorkflowDefinition } from "@chengchenccc/workflow";

export interface WorkflowTriggerScheduler {
  sync(): Promise<void>;
  dispose(): Promise<void>;
}

export interface WorkflowTriggerSchedulerDeps {
  workflowDir: string;
  startExecution(input: {
    workflowId: string;
    definition: WorkflowDefinition;
    input: Record<string, unknown>;
  }): Promise<unknown>;
  /** Scheduler registry (Bun.cron wrapper). */
  schedule(cronExpr: string, fn: () => void): { stop(): void };
}

export function createWorkflowTriggerScheduler(
  deps: WorkflowTriggerSchedulerDeps,
): WorkflowTriggerScheduler {
  const handles = new Map<string, { stop(): void }[]>();
  const single = new Set<string>(); // per-workflow single-flight

  function loadDefinitions(): WorkflowDefinition[] {
    return readdirSync(deps.workflowDir)
      .filter((f) => f.endsWith(".workflow.json"))
      .map((f) => parseWorkflow(JSON.parse(readFileSync(join(deps.workflowDir, f), "utf8"))));
  }

  async function fire(workflowId: string): Promise<void> {
    if (single.has(workflowId)) return;
    single.add(workflowId);
    try {
      const defs = loadDefinitions();
      const def = defs.find((d) => d.id === workflowId);
      if (!def) return;
      await deps.startExecution({ workflowId: def.id, definition: def, input: {} });
    } finally {
      single.delete(workflowId);
    }
  }

  return {
    async sync() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
      for (const def of loadDefinitions()) {
        const list: { stop(): void }[] = [];
        for (const t of def.triggers ?? []) {
          if (t.type === "cron" && t.enabled !== false) {
            list.push(deps.schedule(t.cron, () => void fire(def.id)));
          }
        }
        handles.set(def.id, list);
      }
    },
    async dispose() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
    },
  };
}
