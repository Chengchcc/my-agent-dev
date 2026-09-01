"use client";

interface TimelineApprovalCardProps {
  runId: string;
  approval: { callId: string; toolName: string; reason: string };
  onResolveApproval?: (runId: string, callId: string, decision: "allow" | "deny") => void;
}

export function TimelineApprovalCard({
  runId,
  approval,
  onResolveApproval,
}: TimelineApprovalCardProps) {
  return (
    <div
      data-testid="approval-card"
      className="my-1 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1.5"
    >
      <span className="text-xs text-amber-600">
        ⏸ approve <b>{approval.toolName}</b>
        {approval.reason ? ` — ${approval.reason}` : ""}
      </span>
      <button
        type="button"
        data-testid="approval-allow"
        className="rounded bg-emerald-600 px-2 py-0.5 text-xs text-white hover:bg-emerald-500"
        onClick={() => onResolveApproval?.(runId, approval.callId, "allow")}
      >
        Allow
      </button>
      <button
        type="button"
        data-testid="approval-deny"
        className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-500"
        onClick={() => onResolveApproval?.(runId, approval.callId, "deny")}
      >
        Deny
      </button>
    </div>
  );
}
