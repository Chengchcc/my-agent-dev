"use client";

import { useParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentRunDetail } from "@/features/ops/hooks";

export const dynamic = "force-dynamic";

export default function SystemRunDetailPage() {
  const { runId } = useParams<{ runId: string }>();

  const detailQuery = useAgentRunDetail(runId);
  const run = detailQuery.data?.run;
  const inputs = detailQuery.data?.inputs ?? [];

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/system">System</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbPage>{runId.slice(0, 12)}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {detailQuery.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {detailQuery.error && <p className="text-sm text-destructive">Failed to load run detail</p>}

      {run && (
        <>
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">{run.runId.slice(0, 12)}</h1>
            <Badge>{run.status}</Badge>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Run</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-xs text-[var(--mute)]">Conversation</span>
                <div>{run.conversationId}</div>
              </div>
              <div>
                <span className="text-xs text-[var(--mute)]">Member</span>
                <div>{run.agentMemberId}</div>
              </div>
              <div>
                <span className="text-xs text-[var(--mute)]">Model</span>
                <div>
                  {run.model.backendKind}/{run.model.modelId}
                </div>
              </div>
              <div>
                <span className="text-xs text-[var(--mute)]">Created</span>
                <div>{new Date(run.createdAt).toLocaleString()}</div>
              </div>
              {run.usage && (
                <div>
                  <span className="text-xs text-[var(--mute)]">Usage</span>
                  <div>{(run.usage.inputTokens ?? 0) + (run.usage.outputTokens ?? 0)} tok</div>
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
                <p className="text-sm text-[var(--mute)]">No queued inputs.</p>
              ) : (
                <div className="space-y-1">
                  {inputs.map((i) => (
                    <div
                      key={i.inputId}
                      className="flex items-center justify-between text-sm border-b border-[var(--hairline)] py-1"
                    >
                      <span>
                        {i.mode} · {i.status}
                      </span>
                      <span className="text-xs text-[var(--mute)]">
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
    </div>
  );
}
