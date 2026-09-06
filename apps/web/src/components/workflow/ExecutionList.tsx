"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { ExecutionRowsList, type WorkflowExec } from "./ExecutionRowsList";

type Exec = WorkflowExec;

export function ExecutionList({
  workflowId,
  executions: initialExecutions,
  definition,
}: {
  workflowId: string;
  executions: Exec[];
  definition?: {
    input?: Array<{ key: string; type: "string" | "number" | "boolean" | "artifact" }>;
  } | null;
}) {
  const [inputVals, setInputVals] = useState<Record<string, string>>({});
  const [runOpen, setRunOpen] = useState(false);
  const [artifactSuggestions, setArtifactSuggestions] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const inputHints = definition?.input ?? [];

  async function run() {
    if (running) return;
    setRunning(true);
    const input: Record<string, unknown> = {};
    const artifacts: string[] = [];
    for (const f of inputHints) {
      const raw = inputVals[f.key] ?? "";
      if (raw === "") continue;
      if (f.type === "artifact") {
        // Validate artifact URLs exist before running.
        await api.downloadArtifact(raw).catch(() => {
          throw new Error(`artifact does not exist: ${f.key} = ${raw}`);
        });
        artifacts.push(raw);
        input[f.key] = raw;
      } else if (f.type === "number") input[f.key] = Number(raw);
      else if (f.type === "boolean") input[f.key] = raw === "true";
      else input[f.key] = raw;
    }
    try {
      await api.startWorkflowExecution({
        workflowRef: { repo: "local", path: `${workflowId}.workflow.json` },
        input,
        artifacts,
      });
      window.location.reload();
    } catch (err) {
      toast.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workflows", href: "/workflows" },
          { label: workflowId, href: `/workflows/${workflowId}` },
          { label: "Executions" },
        ]}
        title="Executions"
        description={`Runs of ${workflowId}`}
        action={
          <Dialog open={runOpen} onOpenChange={setRunOpen}>
            <Button
              size="sm"
              onClick={() => {
                setRunOpen(true);
                api
                  .listArtifacts()
                  .then((r) => setArtifactSuggestions((r.artifacts ?? []).map((a) => a.url)))
                  .catch(() => {});
              }}
            >
              + Run
            </Button>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="text-sm font-semibold">Run {workflowId}</DialogTitle>
              </DialogHeader>
              <div className="space-y-3">
                {inputHints.length === 0 ? (
                  <p className="text-xs text-(--mute)">This workflow has no input parameters.</p>
                ) : (
                  inputHints.map((f) => (
                    <div key={f.key} className="flex flex-col gap-1">
                      <Label className="text-xs text-(--mute)">
                        {f.key} <span className="text-(--faint)">({f.type})</span>
                      </Label>
                      {f.type === "artifact" ? (
                        <div className="flex gap-1">
                          <input
                            list="run-artifact-suggestions"
                            className="h-9 flex-1 border-(--hairline) bg-(--canvas) px-2 text-xs"
                            placeholder="artifacts://folder/file"
                            value={inputVals[f.key] ?? ""}
                            onChange={(e) =>
                              setInputVals((v) => ({ ...v, [f.key]: e.target.value }))
                            }
                          />
                          <datalist id="run-artifact-suggestions">
                            {artifactSuggestions.map((u) => (
                              <option key={u} value={u} />
                            ))}
                          </datalist>
                        </div>
                      ) : (
                        <Input
                          className="h-9 border-(--hairline) bg-(--canvas) text-xs"
                          type={
                            f.type === "number" ? "number" : f.type === "boolean" ? "text" : "text"
                          }
                          placeholder={f.type === "boolean" ? "true / false" : ""}
                          value={inputVals[f.key] ?? ""}
                          onChange={(e) => setInputVals((v) => ({ ...v, [f.key]: e.target.value }))}
                        />
                      )}
                    </div>
                  ))
                )}
                <Button
                  className="w-full"
                  disabled={running}
                  onClick={async () => {
                    await run();
                    setRunOpen(false);
                  }}
                >
                  {running ? "Starting…" : "Submit"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />
      <PageBody className="space-y-2">
        <ExecutionRowsList workflowId={workflowId} executions={initialExecutions} />
      </PageBody>
    </Page>
  );
}
