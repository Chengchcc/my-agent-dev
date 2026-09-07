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
    triggeredBy?: string;
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
    // Per-file isolation: one malformed/unparsable definition must not kill
    // trigger sync for every OTHER workflow (nor brick backend boot, which
    // awaits sync()). Skip + log; the file stays visible in the UI.
    const defs: WorkflowDefinition[] = [];
    for (const f of readdirSync(deps.workflowDir).filter((f) => f.endsWith(".workflow.json"))) {
      try {
        defs.push(parseWorkflow(JSON.parse(readFileSync(join(deps.workflowDir, f), "utf8"))));
      } catch (err) {
        console.error(
          `[trigger-scheduler] skipping unparsable definition ${f}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return defs;
  }

  async function fire(workflowId: string, cron?: string): Promise<void> {
    if (single.has(workflowId)) return;
    single.add(workflowId);
    try {
      const defs = loadDefinitions();
      const def = defs.find((d) => d.id === workflowId);
      if (!def) return;
      await deps.startExecution({
        workflowId: def.id,
        definition: def,
        input: {},
        triggeredBy: cron ? `cron:${cron}` : "manual",
      });
    } catch (err) {
      // A rejected fire (SQLITE_BUSY, disk full, …) must never reject out of
      // the Bun.cron callback: an unhandled rejection kills the whole
      // backend process. Log and keep serving.
      console.error(
        `[trigger-scheduler] fire ${workflowId} (${cron ?? "manual"}) failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      single.delete(workflowId);
    }
  }

  return {
    async sync() {
      for (const hs of handles.values()) for (const h of hs) h.stop();
      handles.clear();
      // M5: handles are keyed by definition id — a second file with the
      // same id would overwrite the first handle list and orphan its
      // Bun.cron timers forever (one more leaked set on every sync).
      const seen = new Set<string>();
      for (const def of loadDefinitions()) {
        if (seen.has(def.id)) {
          console.error(
            `[trigger-scheduler] duplicate workflow id "${def.id}" — later definition skipped; ` +
              `rename one of the files or fix definition.id`,
          );
          continue;
        }
        seen.add(def.id);
        const list: { stop(): void }[] = [];
        for (const t of def.triggers ?? []) {
          if (t.type === "cron" && t.enabled !== false) {
            try {
              list.push(deps.schedule(t.cron, () => void fire(def.id, t.cron)));
            } catch (err) {
              // A bad cron expression must not take down the whole
              // trigger subsystem — skip this trigger, keep the rest.
              console.error(
                `[trigger-scheduler] invalid cron "${t.cron}" on ${def.id}:`,
                err instanceof Error ? err.message : err,
              );
            }
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
