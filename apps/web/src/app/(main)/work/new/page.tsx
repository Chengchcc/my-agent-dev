"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useActivateLoop, useCreateLoop } from "@/features/loop/hooks";

const MonacoViewer = dynamic(
  () => import("@/components/MonacoViewer").then((m) => m.MonacoViewer),
  {
    ssr: false,
    loading: () => <div className="h-96 animate-pulse rounded-md bg-[var(--canvas-soft)]" />,
  },
);

type Stage = "intent" | "preview";

export default function NewLoopPage() {
  const router = useRouter();
  const createLoop = useCreateLoop();
  const activateLoop = useActivateLoop();
  const [stage, setStage] = useState<Stage>("intent");
  const [intent, setIntent] = useState("");
  const [loopId, setLoopId] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [loopName, setLoopName] = useState("");
  const [note, setNote] = useState("");

  function handleCreate() {
    createLoop.mutate(
      { name: intent.slice(0, 30) || "new-loop", intent },
      {
        onSuccess: (res) => {
          if (res.status === "generated" && res.loop) {
            setLoopId(res.loop.id);
            setPreview(res.loop.preview);
            setLoopName(res.loop.name);
            setStage("preview");
          }
        },
        onError: (err) => {
          toast.error("Failed to generate loop", {
            description: err instanceof Error ? err.message : "Unknown error",
          });
        },
      },
    );
  }

  function handleActivate() {
    if (!loopId) return;
    activateLoop.mutate(loopId, {
      onSuccess: () => {
        router.push(`/work/${loopId}`);
      },
      onError: (err) => {
        toast.error("Activation failed", {
          description: err instanceof Error ? err.message : "Unknown error",
        });
      },
    });
  }

  function reset() {
    setStage("intent");
    setIntent("");
    setLoopId(null);
    setPreview("");
    setLoopName("");
    setNote("");
  }

  return (
    <Page>
      <PageHeader
        breadcrumb="Work / New"
        title="New Loop"
        description="Define the automation goal. You can configure its schedule and items after creation."
      />
      <PageBody size="reading">
        {stage === "intent" && (
          <Card>
            <CardHeader>
              <CardTitle>What do you want to automate?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-[var(--muted)]">
                Loops are created as manual drafts: the goal becomes the loop name and a starting
                LOOP.md. You set the schedule and items after creation.
              </p>
              <Textarea
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                placeholder="e.g. Summarize GitHub PR status to Lark every morning"
                rows={6}
              />
              <Button onClick={handleCreate} disabled={!intent.trim() || createLoop.isPending}>
                {createLoop.isPending ? "Creating draft…" : "Create draft"}
              </Button>
            </CardContent>
          </Card>
        )}

        {stage === "preview" && (
          <Card>
            <CardHeader>
              <CardTitle>Preview LOOP.md</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Loop name</label>
                <Input value={loopName} onChange={(e) => setLoopName(e.target.value)} />
              </div>
              {note && (
                <div className="text-sm text-[var(--muted)] bg-[var(--canvas-soft)] rounded p-3">
                  {note}
                </div>
              )}
              {preview ? (
                <MonacoViewer value={preview} path="LOOP.md" />
              ) : (
                <p className="text-sm text-[var(--muted)]">(no preview)</p>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset}>
                  Regenerate
                </Button>
                <Button onClick={handleActivate} disabled={activateLoop.isPending}>
                  {activateLoop.isPending ? "Activating…" : "Confirm and enable"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </PageBody>
    </Page>
  );
}
