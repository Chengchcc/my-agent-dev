"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Page, PageBody, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentRunDetail } from "@/features/ops/hooks";

export const dynamic = "force-dynamic";

export default function SystemRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");

  const detailQuery = useAgentRunDetail(runId);
  const run = detailQuery.data?.run;
  const inputs = detailQuery.data?.inputs ?? [];

  return (
    <Page>
      <PageHeader
        breadcrumb={
          from ? (
            <Link href={from} className="text-(--info) hover:underline">
              ← Back to conversation
            </Link>
          ) : (
            "System / Runs"
          )
        }
        title={run ? run.runId.slice(0, 12) : runId.slice(0, 12)}
        action={run ? <Badge>{run.status}</Badge> : undefined}
      />
      <PageBody className="space-y-6">
        {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {detailQuery.error && <p className="text-sm text-destructive">Failed to load run detail</p>}

        {run && (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Run</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-xs text-(--mute)">Conversation</span>
                  <div>{run.conversationId}</div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Member</span>
                  <div>{run.agentId}</div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Model</span>
                  <div>
                    {run.model.modelId}
                    <span className="text-[10px] text-(--mute)"> ({run.model.backendKind})</span>
                  </div>
                </div>
                <div>
                  <span className="text-xs text-(--mute)">Created</span>
                  <div>{new Date(run.createdAt).toLocaleString()}</div>
                </div>
                {run.usage && (
                  <div>
                    <span className="text-xs text-(--mute)">Usage</span>
                    <div>{(run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)} tok</div>
                  </div>
                )}
                {run.usage?.costUsd != null && (
                  <div>
                    <span className="text-xs text-(--mute)">Cost</span>
                    <div>${run.usage.costUsd.toFixed(4)}</div>
                  </div>
                )}
                {run.terminalResult &&
                  "error" in run.terminalResult &&
                  run.terminalResult.error && (
                    <div className="col-span-2">
                      <span className="text-xs text-(--mute)">Error</span>
                      <div className="font-mono text-xs text-red-400">
                        {run.terminalResult.error}
                      </div>
                    </div>
                  )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Queued inputs</CardTitle>
              </CardHeader>
              <CardContent>
                {inputs.length === 0 ? (
                  <p className="text-sm text-(--mute)">No queued inputs.</p>
                ) : (
                  <div className="space-y-1">
                    {inputs.map((i) => (
                      <div
                        key={i.inputId}
                        className="flex items-center justify-between text-sm border-b border-(--hairline) py-1"
                      >
                        <span>
                          {i.mode} · {i.status}
                        </span>
                        <span className="text-xs text-(--mute)">
                          {new Date(i.createdAt).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </PageBody>
    </Page>
  );
}
